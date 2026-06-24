/**
 * 短信服务 - 核心编排层
 * 串联 modem、解析、去重、通知、数据库
 *
 * 长短信处理策略：
 * 1. +CMTI 缓冲 500ms 后批量读取（避免模块写入未完成时读取）
 * 2. 含 OTP 的验证码短信 → 立即推送（零延迟）
 * 3. 普通短信 → 进入聚合器，同号码 5 秒内无新消息后合并推送
 * 4. 合并后重新提取 OTP（关键词和数字可能分在不同片段）
 */

import modem from '../serial/modem.js';
import { parseCMGR, parseCMGL, autoDecodeUCS2 } from '../serial/parser.js';
import { buildSmsRecord, normalizeTimestamp } from './sms.parser.js';
import { extractOtp } from './otp.js';
import { SmsAggregator } from './aggregator.js';
import { generateHash, existsByHash, insertSms } from '../database/sqlite.js';
import config from '../config/index.js';
import logger from '../logger/index.js';
import { broadcast } from '../web/server.js';

// 根据配置动态加载通知渠道
const notifierModule = config.notifier === 'bark'
  ? await import('../notifier/bark.js')
  : await import('../notifier/feishu.js');
const notifier = notifierModule.default;

// +CMTI 批量读取延迟：等模块完成短信写入
const BATCH_DELAY_MS = 500;
// 单条读取前额外等待，给 SIM 卡写入充裕时间
const READ_DELAY_MS = 300;

/** @type {number[]} */
let pendingIndices = [];
/** @type {NodeJS.Timeout|null} */
let batchTimer = null;
// 防止同一索引被并发处理（CMTI 可能重复触发）
/** @type {Set<number>} */
const processingIndexes = new Set();

// 普通短信聚合器（5 秒窗口）
const aggregator = new SmsAggregator(5000);

/**
 * 将新短信索引加入批处理队列
 *
 * 延迟 500ms 后批量读取，确保模块完成短信写入。
 * 自动去重：同一索引不会被重复处理。
 *
 * @param {number} index - SIM 卡中的短信索引
 */
export function queueNewSms(index) {
  // 跳过正在处理或已在队列中的索引
  if (processingIndexes.has(index) || pendingIndices.includes(index)) {
    logger.debug({ index }, '索引已在处理队列中，跳过');
    return;
  }
  pendingIndices.push(index);

  if (batchTimer) clearTimeout(batchTimer);

  batchTimer = setTimeout(async () => {
    const indices = pendingIndices.splice(0);
    batchTimer = null;
    await processBatch(indices);
  }, BATCH_DELAY_MS);
}

/**
 * 处理 +CMT 直接投递的短信（CNMI mt=2 模式）
 *
 * 与 +CMTI 不同，+CMT 短信不经过 SIM 卡存储，内容直接在 URC 中推送。
 * 优点：不依赖 SIM 读写，不会出现 321 错误。
 *
 * @param {{ phone: string, timestamp: string, rawContent: string, _ucs2: boolean }} data
 */
export async function handleDirectSms(data) {
  const { phone, timestamp, rawContent, _ucs2 } = data;
  const content = _ucs2 ? autoDecodeUCS2(rawContent) : rawContent;

  if (!content) {
    logger.warn({ phone }, '+CMT 短信内容为空');
    return;
  }

  logger.info({ phone, contentLen: content.length }, '处理 +CMT 直接投递短信');

  const sms = {
    phone,
    content,
    timestamp: normalizeTimestamp(timestamp),
  };

  // 复用现有的分流逻辑（OTP 立即推送 / 普通短信聚合）
  // index 设为 -1 表示非 SIM 存储（不需要删除）
  await routeSms(sms, -1, [`+CMT direct: ${phone}`]);
}

/**
 * 批量读取短信并分流处理
 *
 * 策略：
 *   1. 逐个 AT+CMGR 读取（快、精确）
 *   2. 如果遇到 321（索引失效），累计失败次数
 *   3. 有失败时，最后用 AT+CMGL 兜底扫描所有未读（慢但可靠）
 *
 * @param {number[]} indices
 */
async function processBatch(indices) {
  let failedCount = 0;

  for (const index of indices) {
    processingIndexes.add(index);
    try {
      // 额外延迟，给 SIM 卡写入充裕时间（Air724UG 偶发写入延迟）
      await sleep(READ_DELAY_MS);

      const lines = await modem.send(`AT+CMGR=${index}`);
      const parsed = parseCMGR(lines);

      if (!parsed || !parsed.content) {
        logger.warn({ index, lines }, '短信解析失败或内容为空');
        continue;
      }

      const sms = buildSmsRecord(parsed);
      await routeSms(sms, index, lines);
    } catch (err) {
      if (err.message?.includes('321')) {
        logger.info({ index }, '短信索引不存在 (321)，将尝试 CMGL 兜底');
        failedCount++;
        // 首次失败时输出诊断信息
        if (failedCount === 1) {
          try {
            const cscsInfo = await modem.send('AT+CSCS?');
            const cpmsInfo = await modem.send('AT+CPMS?');
            logger.info({ cscs: cscsInfo.join(' '), cpms: cpmsInfo.join(' ') }, '321 诊断: 当前模块状态');
          } catch { /* ignore */ }
        }
      } else {
        logger.error({ err, index }, '读取短信失败');
      }
    } finally {
      processingIndexes.delete(index);
    }
  }

  // 有索引失败时，用 AT+CMGL 兜底扫描未读短信
  if (failedCount > 0) {
    logger.info({ failedCount }, '存在索引失效，执行 CMGL 兜底扫描');
    await fallbackScanUnread();
  }
}

/**
 * 发送 AT+CMGL 指令（处理 CSCS 兼容性）
 *
 * Air724UG 文本模式下 CMGL 必须用字符串参数（"REC UNREAD"/"ALL"），
 * 数字参数只在 PDU 模式有效，会返回 305 错误。
 *
 * 当 CSCS="UCS2" 时字符串参数可能被 hex 编码，所以：
 *   1. 先尝试直接发送字符串参数
 *   2. 如果 305 失败，临时切 GSM 字符集重试
 *
 * @param {string} filter - "REC UNREAD" | "ALL"
 * @returns {Promise<string[]>}
 */
async function sendCmgl(filter) {
  try {
    return await modem.send(`AT+CMGL="${filter}"`);
  } catch (err) {
    if (!err.message?.includes('305')) throw err;

    // 305 = 字符串参数被 UCS2 编码干扰，临时切 GSM 重试
    logger.info({ filter }, 'CMGL 字符串参数失败(305)，切换 GSM 字符集重试');
    await modem.send('AT+CSCS="GSM"');
    try {
      return await modem.send(`AT+CMGL="${filter}"`);
    } finally {
      try { await modem.send('AT+CSCS="UCS2"'); } catch { /* ignore */ }
    }
  }
}

/**
 * AT+CMGL 兜底扫描：读取所有未读短信
 * 用于 AT+CMGR 索引失效时的可靠回退
 */
async function fallbackScanUnread() {
  try {
    // 先查询 CPMS 状态辅助诊断
    try {
      const cpmsLines = await modem.send('AT+CPMS?');
      logger.info({ cpms: cpmsLines.join(' ') }, 'CMGL 兜底: 当前存储区');
    } catch { /* ignore */ }

    let lines = await sendCmgl('REC UNREAD');
    let messages = parseCMGL(lines);

    if (messages.length === 0) {
      logger.info('CMGL 兜底: 未读为空，尝试读取全部短信');
      lines = await sendCmgl('ALL');
      messages = parseCMGL(lines);
    }

    if (messages.length === 0) {
      logger.info('CMGL 兜底: SIM 卡中无短信');
      return;
    }

    logger.info({ count: messages.length }, 'CMGL 兜底扫描发现短信');

    for (const msg of messages) {
      const sms = buildSmsRecord(msg);
      await routeSms(sms, msg.index, [JSON.stringify(msg)]);
    }
  } catch (err) {
    logger.error({ err }, 'CMGL 兜底扫描失败');
  }
}

/** @param {number} ms */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 分流：验证码立即推送，普通短信进入聚合器
 */
async function routeSms(sms, index, rawLines) {
  const { otp } = extractOtp(sms.content);

  if (otp) {
    // 验证码短信立即推送，不等待
    logger.info({ phone: sms.phone, otp }, '检测到验证码，立即推送');
    await pushAndSave({
      phone: sms.phone,
      content: sms.content,
      otp,
      timestamp: sms.timestamp,
      indices: [index],
      rawParts: [rawLines.join('\n')],
    });
    return;
  }

  // 普通短信进入聚合器（同号码 5 秒无新消息后合并推送）
  aggregator.add(
    { phone: sms.phone, content: sms.content, timestamp: sms.timestamp, index, rawLines },
    async (merged) => {
      // 合并后重新提取 OTP（关键词和数字可能分在不同片段）
      const { otp: mergedOtp } = extractOtp(merged.content);
      await pushAndSave({
        phone: merged.phone,
        content: merged.content,
        otp: mergedOtp,
        timestamp: merged.timestamp,
        indices: merged.indices,
        rawParts: merged.rawParts,
      });
    }
  );
}

/**
 * 通用的推送 + 入库 + 广播 + 删除流程
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {string} params.content
 * @param {string|null} params.otp
 * @param {string} params.timestamp
 * @param {number[]} params.indices
 * @param {string[]} params.rawParts
 */
async function pushAndSave({ phone, content, otp, timestamp, indices, rawParts }) {
  // 去重
  const hash = generateHash(phone, content, timestamp);
  if (existsByHash(hash)) {
    logger.info({ phone, hash }, '重复短信，跳过');
    for (const idx of indices) await deleteSms(idx);
    return;
  }

  logger.info({ phone, otp }, '处理新短信');

  // 推送通知
  const forwarded = await notifier.send({ phone, content, otp });

  // 入库
  insertSms({
    hash,
    smsIndex: indices[0],
    phone,
    content,
    otp,
    receivedAt: timestamp,
    forwarded: forwarded ? 1 : 0,
    raw: rawParts.join('\n---PART---\n'),
  });

  // WebSocket 推送到 Web 面板
  broadcast('sms', { phone, content, otp, timestamp, forwarded });

  // 删除 SIM 上的短信
  for (const idx of indices) await deleteSms(idx);
}

/**
 * 启动时扫描并处理所有未读短信
 *
 * 启动扫描使用同步分组（按号码 + 时间戳），因为所有消息一次性获取，
 * 不需要等待聚合窗口。
 */
export async function scanUnread() {
  try {
    logger.info('开始扫描未读短信...');

    // 文本模式下必须用字符串参数，数字参数只在 PDU 模式有效（会返回 305）
    const lines = await sendCmgl('REC UNREAD');
    const messages = parseCMGL(lines);

    if (messages.length === 0) {
      logger.info('无未读短信');
      return;
    }

    logger.info({ count: messages.length }, '发现未读短信');

    // 构建记录
    const items = messages.map((msg) => ({
      sms: buildSmsRecord(msg),
      index: msg.index,
      rawLines: [JSON.stringify(msg)],
    }));

    // 按号码分组 → 按时间戳子分组 → 合并处理
    const phoneGroups = groupByPhone(items);

    for (const samePhoneItems of phoneGroups.values()) {
      const mergeGroups = subGroupByTimestamp(samePhoneItems);
      for (const group of mergeGroups) {
        await processScanGroup(group);
      }
    }

    logger.info({ count: messages.length }, '未读短信扫描完成');
  } catch (err) {
    logger.error({ err }, '扫描未读短信失败');
  }
}

// ─── scanUnread 辅助函数 ────────────────────────────────────

// 同号码短信 SMSC 时间戳差距 ≤10 秒视为同一条长短信的片段
const MERGE_WINDOW_MS = 10_000;

/**
 * 解析 AT 响应中的 SMSC 时间戳为毫秒数
 * @param {string} ts
 * @returns {number} 解析失败返回 0
 */
function parseTimestampMs(ts) {
  if (!ts) return 0;
  const match = ts.match(/(\d{2,4})\D(\d{2})\D(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return 0;
  let [, year, month, day, hour, min, sec] = match.map(Number);
  if (year < 100) year += 2000;
  return new Date(year, month - 1, day, hour, min, sec).getTime();
}

function groupByPhone(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.sms.phone;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/**
 * 同号码内按 SMSC 时间戳分组
 * 时间戳差距 ≤ MERGE_WINDOW_MS 的归为一组（长短信片段）
 */
function subGroupByTimestamp(items) {
  if (items.length <= 1) return [items];

  items.sort((a, b) => a.index - b.index);

  const groups = [];
  let currentGroup = [items[0]];

  for (let i = 1; i < items.length; i++) {
    const baseTs = parseTimestampMs(currentGroup[0].sms.timestamp);
    const currTs = parseTimestampMs(items[i].sms.timestamp);

    if (baseTs > 0 && currTs > 0 && Math.abs(currTs - baseTs) <= MERGE_WINDOW_MS) {
      currentGroup.push(items[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [items[i]];
    }
  }

  groups.push(currentGroup);
  return groups;
}

/**
 * 处理扫描到的一组短信（可能是合并后的）
 */
async function processScanGroup(items) {
  items.sort((a, b) => a.index - b.index);

  const phone = items[0].sms.phone;
  const timestamp = items[0].sms.timestamp;
  const mergedContent = items.map((i) => i.sms.content).join('');
  const { otp } = extractOtp(mergedContent);
  const indices = items.map((i) => i.index);

  if (items.length > 1) {
    logger.info(
      { phone, parts: items.length, mergedLength: mergedContent.length },
      '未读长短信已合并'
    );
  }

  await pushAndSave({
    phone,
    content: mergedContent,
    otp,
    timestamp,
    indices,
    rawParts: items.map((i) => i.rawLines.join('\n')),
  });
}

// ─── 公共工具 ──────────────────────────────────────────────

/**
 * 删除 SIM 卡上的短信
 * @param {number} index
 */
async function deleteSms(index) {
  // index < 0 表示 +CMT 直接投递，不在 SIM 存储中，无需删除
  if (index < 0 || !config.sms.deleteAfterForward) return;

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
    // 重新设置 CNMI（mt=2 保持直接投递模式），防止被重置
    await modem.send('AT+CNMI=2,2,0,0,0');
    logger.info('存储满清理完成，CNMI 已重新设置');
  } catch (err) {
    logger.error({ err }, '存储满清理失败');
  }
}
