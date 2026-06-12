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
import { queueNewSms, scanUnread, handleStorageFull } from './sms/sms.service.js';
import { startWebServer } from './web/server.js';

/** @type {NodeJS.Timeout|null} */
let cnmiTimer = null;

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

  // 开启短信实时通知
  await modem.send('AT+CNMI=2,1,0,0,0');
  logger.info('已开启短信通知 (AT+CNMI=2,1,0,0,0)');

  // 设置短信存储区
  await modem.send('AT+CPMS="SM","SM","SM"');
  logger.info('已设置短信存储区 (SM)');

  // 查询当前字符集
  try {
    const cscsLines = await modem.send('AT+CSCS?');
    logger.info({ cscs: cscsLines.join(' ') }, '当前字符集');
  } catch {
    logger.debug('查询字符集失败');
  }

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
  // 新短信通知（加入批处理队列，等待长短信片段到齐后合并处理）
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
      await scanUnread();
    } catch (err) {
      logger.error({ err }, '重连后初始化失败');
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
      await modem.send('AT+CNMI=2,1,0,0,0');
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
