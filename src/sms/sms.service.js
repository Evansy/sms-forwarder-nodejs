/**
 * 短信服务 - 核心编排层
 * 串联 modem、解析、去重、通知、数据库
 */

import modem from '../serial/modem.js';
import { parseCMGR, parseCMGL } from '../serial/parser.js';
import { buildSmsRecord } from './sms.parser.js';
import { generateHash, existsByHash, insertSms } from '../database/sqlite.js';
import config from '../config/index.js';
import logger from '../logger/index.js';
import { broadcast } from '../web/server.js';

/**
 * 检测内容是否为运营商长短信拆分产生的片段
 * 文本模式下超长短信被拆成多条，尾部常含 URL 参数残片等无意义内容
 * 片段特征：短（<20字符）、无中文、无验证码关键词
 */
function isFragment(content) {
  if (!content || content.length >= 20) return false;
  if (/[\u4e00-\u9fff]/.test(content)) return false;
  if (/验证码|校验码|动态码|code|otp|pin/i.test(content)) return false;
  return true;
}

// 根据配置动态加载通知渠道
const notifierModule = config.notifier === 'bark'
  ? await import('../notifier/bark.js')
  : await import('../notifier/feishu.js');
const notifier = notifierModule.default;

/**
 * 处理单条新短信（由 +CMTI 触发）
 * @param {number} index - SIM 卡中的短信索引
 */
export async function handleNewSms(index) {
  try {
    // 1. 读取短信
    const lines = await modem.send(`AT+CMGR=${index}`);
    const parsed = parseCMGR(lines);

    if (!parsed || !parsed.content) {
      logger.warn({ index, lines }, '短信解析失败或内容为空');
      return;
    }

    // 2. 构建短信记录
    const sms = buildSmsRecord(parsed);

    // 3. 去重检查
    const hash = generateHash(sms.phone, sms.content, sms.timestamp);
    if (existsByHash(hash)) {
      logger.info({ phone: sms.phone, hash }, '重复短信，跳过');
      await deleteSms(index);
      return;
    }

    logger.info({ phone: sms.phone, otp: sms.otp }, '处理新短信');

    // 4. 推送通知（长短信片段不推送，仅入库）
    let forwarded = false;
    if (isFragment(sms.content)) {
      logger.info({ phone: sms.phone, content: sms.content }, '检测到长短信片段，跳过推送');
    } else {
      forwarded = await notifier.send({
        phone: sms.phone,
        content: sms.content,
        otp: sms.otp,
      });
    }

    // 5. 入库
    insertSms({
      hash,
      smsIndex: index,
      phone: sms.phone,
      content: sms.content,
      otp: sms.otp,
      receivedAt: sms.timestamp,
      forwarded: forwarded ? 1 : 0,
      raw: lines.join('\n'),
    });

    // 6. WebSocket 实时推送到 Web 面板
    broadcast('sms', {
      phone: sms.phone,
      content: sms.content,
      otp: sms.otp,
      timestamp: sms.timestamp,
      forwarded,
    });

    // 7. 删除 SIM 卡上的短信
    await deleteSms(index);
  } catch (err) {
    logger.error({ err, index }, '处理短信失败');
  }
}

/**
 * 启动时扫描并处理所有未读短信
 */
export async function scanUnread() {
  try {
    logger.info('开始扫描未读短信...');

    const lines = await modem.send('AT+CMGL="REC UNREAD"');
    const messages = parseCMGL(lines);

    if (messages.length === 0) {
      logger.info('无未读短信');
      return;
    }

    logger.info({ count: messages.length }, '发现未读短信');

    for (const msg of messages) {
      const sms = buildSmsRecord(msg);
      const hash = generateHash(sms.phone, sms.content, sms.timestamp);

      if (existsByHash(hash)) {
        logger.info({ phone: sms.phone, hash }, '重复短信，跳过');
        await deleteSms(msg.index);
        continue;
      }

      logger.info({ phone: sms.phone, otp: sms.otp, index: msg.index }, '补推未读短信');

      let forwarded = false;
      if (isFragment(sms.content)) {
        logger.info({ phone: sms.phone, content: sms.content }, '检测到长短信片段，跳过推送');
      } else {
        forwarded = await notifier.send({
          phone: sms.phone,
          content: sms.content,
          otp: sms.otp,
        });
      }

      insertSms({
        hash,
        smsIndex: msg.index,
        phone: sms.phone,
        content: sms.content,
        otp: sms.otp,
        receivedAt: sms.timestamp,
        forwarded: forwarded ? 1 : 0,
        raw: JSON.stringify(msg),
      });

      await deleteSms(msg.index);
    }

    logger.info({ count: messages.length }, '未读短信扫描完成');
  } catch (err) {
    logger.error({ err }, '扫描未读短信失败');
  }
}

/**
 * 删除 SIM 卡上的短信
 * @param {number} index
 */
async function deleteSms(index) {
  if (!config.sms.deleteAfterForward) return;

  try {
    await modem.send(`AT+CMGD=${index}`);
    logger.debug({ index }, '短信已从 SIM 卡删除');
  } catch (err) {
    // CMS ERROR 321 = 无效索引，可能短信已被删除或索引已变化，属正常情况
    // 删除失败不影响主流程
    const isInvalidIndex = err.message?.includes('321');
    const logLevel = isInvalidIndex ? 'debug' : 'warn';
    logger[logLevel]({ err: err.message, index }, '删除短信失败');
  }
}

/**
 * 存储满时清空所有短信
 */
export async function handleStorageFull() {
  try {
    logger.warn('执行存储满清理: AT+CMGD=1,4');
    await modem.send('AT+CMGD=1,4');
    // 重新设置 CNMI，防止被重置
    await modem.send('AT+CNMI=2,1,0,0,0');
    logger.info('存储满清理完成，CNMI 已重新设置');
  } catch (err) {
    logger.error({ err }, '存储满清理失败');
  }
}
