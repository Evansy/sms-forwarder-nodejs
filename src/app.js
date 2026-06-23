/**
 * SMS Forwarder 主入口
 *
 * 启动流程：
 * 1. 加载配置 → 校验
 * 2. 初始化日志、数据库
 * 3. 打开串口
 * 4. 发送初始化 AT 指令序列
 * 5. 扫描未读短信并补推
 * 6. 清理已读短信
 * 7. 进入实时监听模式
 * 8. 启动 CNMI 定时刷新
 */

import config, { validateConfig } from './config/index.js';
import logger from './logger/index.js';
import { closeDb } from './database/sqlite.js';
import modem from './serial/modem.js';
import { queueNewSms, handleDirectSms, scanUnread, handleStorageFull } from './sms/sms.service.js';
import { startWebServer } from './web/server.js';

/** @type {NodeJS.Timeout|null} */
let cnmiTimer = null;

/** @param {number} ms */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 发送初始化 AT 指令序列
 */
async function initModem() {
  // 测试通信
  await modem.send('AT');
  logger.info('AT 通信正常');

  // 文本模式
  await modem.send('AT+CMGF=1');
  logger.info('已设置文本模式 (AT+CMGF=1)');

  // 关闭 RNDIS USB 网卡，防止 N1 走 SIM 卡流量
  try {
    await modem.send('AT+RNDISCALL=0,0');
    logger.info('已关闭 RNDIS 网卡 (AT+RNDISCALL=0,0)');
  } catch {
    // 部分固件不支持此指令，忽略错误
    logger.debug('AT+RNDISCALL 不支持或已关闭，跳过');
  }

  // 开启短信直接投递模式（mt=2: +CMT 直接推送内容，不存入 SIM）
  // Air724UG 的 SIM 卡存储有兼容问题（+CMTI 通知但 SIM 为空），
  // 直接投递模式绕过 SIM 存储，内容随 URC 推送，更可靠。
  await modem.send('AT+CNMI=2,2,0,0,0');
  logger.info('已开启短信直接投递 (AT+CNMI=2,2,0,0,0)');

  // 设置短信存储区
  await modem.send('AT+CPMS="SM","SM","SM"');
  logger.info('已设置短信存储区 (SM)');

  // 强制设置 UCS2 字符集
  // 解析器依赖 UCS2 hex 格式来检测和解码中文内容；
  // 不同 SIM 卡默认字符集不同（giffgaff=UCS2, 中国电信=GSM），
  // 主动设置确保行为一致
  await modem.send('AT+CSCS="UCS2"');
  logger.info('已设置字符集 UCS2 (AT+CSCS="UCS2")');

  // 查询信号强度
  try {
    const csqLines = await modem.send('AT+CSQ');
    logger.info({ csq: csqLines.join(' ') }, '信号强度');
  } catch {
    logger.warn('查询信号强度失败');
  }

  // 查询 SIM 卡状态
  try {
    const cpinLines = await modem.send('AT+CPIN?');
    logger.info({ cpin: cpinLines.join(' ') }, 'SIM 卡状态');
  } catch {
    logger.warn('查询 SIM 卡状态失败');
  }
}

/**
 * 注册事件监听
 */
function setupEventHandlers() {
  // +CMT 直接投递（主模式）：CNMI mt=2，短信内容直接在 URC 中推送
  modem.on('cmt', (data) => {
    handleDirectSms(data);
  });

  // +CMTI 回退（兼容）：如果 CNMI 被模块重置为 mt=1，仍能处理
  modem.on('cmti', (index) => {
    queueNewSms(index);
  });

  // 存储满自愈
  modem.on('smsfull', () => {
    handleStorageFull();
  });

  // 串口重连后重新初始化
  modem.on('reconnect', async () => {
    logger.info('串口重连成功，重新初始化模块');
    try {
      await initModem();
    } catch (err) {
      logger.error({ err }, '重连后初始化模块失败，将等待下次重连');
      return;
    }

    // 等待模块就绪后再扫描未读短信
    // 重连后 CSQ 可能返回 99,99（信号未恢复），SIM 卡尚未就绪
    // 立即执行 AT+CMGL 会触发 CMS ERROR 302
    const maxWait = 10_000;
    const checkInterval = 1_000;
    let waited = 0;
    while (waited < maxWait) {
      await sleep(checkInterval);
      waited += checkInterval;
      try {
        const csqLines = await modem.send('AT+CSQ');
        const csq = csqLines.join(' ');
        // CSQ 99,99 表示信号未恢复，继续等待
        if (!csq.includes('99,99')) {
          logger.info({ csq, waitedMs: waited }, '模块信号已恢复');
          break;
        }
        logger.debug({ waitedMs: waited }, '模块信号未恢复，继续等待...');
      } catch {
        logger.debug({ waitedMs: waited }, '信号查询失败，继续等待...');
      }
    }

    if (waited >= maxWait) {
      logger.warn({ waitedMs: waited }, '等待模块就绪超时，尝试扫描未读短信');
    }

    // scanUnread 带重试：CMS ERROR 302 时延迟重试
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await scanUnread();
        break;
      } catch (err) {
        if (attempt < 3) {
          const retryDelay = attempt * 3_000;
          logger.warn({ err: err.message, attempt, retryDelay }, '扫描未读短信失败，稍后重试');
          await sleep(retryDelay);
        } else {
          logger.error({ err }, '扫描未读短信最终失败');
        }
      }
    }
  });
}

/**
 * 启动 CNMI 定时刷新
 * 防止模块在某些事件后重置 CNMI 配置
 */
function startCnmiRefresh() {
  cnmiTimer = setInterval(async () => {
    try {
      await modem.send('AT+CNMI=2,2,0,0,0');
      logger.debug('CNMI 定时刷新完成');
    } catch (err) {
      logger.warn({ err: err.message }, 'CNMI 定时刷新失败');
    }
  }, config.sms.cnmiRefreshInterval);
}

/**
 * 优雅退出
 */
async function shutdown(signal) {
  logger.info({ signal }, '收到退出信号，开始清理...');

  if (cnmiTimer) {
    clearInterval(cnmiTimer);
    cnmiTimer = null;
  }

  await modem.close();
  closeDb();

  logger.info('服务已停止');
  process.exit(0);
}

/**
 * 主函数
 */
async function main() {
  try {
    // 1. 校验配置
    validateConfig();
    logger.info('配置校验通过');

    // 2. 打开串口
    await modem.open();

    // 3. 初始化模块
    await initModem();

    // 4. 注册事件
    setupEventHandlers();

    // 5. 扫描未读短信并补推
    await scanUnread();

    // 6. 清理已读短信（补推完成后）
    try {
      await modem.send('AT+CMGD=1,3');
      logger.info('已清理已读短信 (AT+CMGD=1,3)');
    } catch {
      logger.debug('无已读短信需要清理');
    }

    // 7. 启动 CNMI 定时刷新
    startCnmiRefresh();

    // 8. 启动 Web 面板
    startWebServer();

    // 9. 注册信号处理
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('SMS Forwarder 启动完成，等待短信...');
  } catch (err) {
    logger.fatal({ err }, '启动失败');
    process.exit(1);
  }
}

main();
