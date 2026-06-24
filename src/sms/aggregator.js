/**
 * 短信聚合器
 *
 * 运营商可能将长短信拆成多条独立短信（无 UDH 头），
 * 聚合器按号码缓冲短信，等待窗口期后合并推送。
 *
 * 使用方式：
 *   aggregator.add(item, callback)
 *   - 同号码每收到新消息重置定时器
 *   - 窗口期内无新消息后触发 callback，返回合并结果
 *
 * 验证码短信不走聚合器，由 sms.service 直接推送。
 */

import logger from '../logger/index.js';

const DEFAULT_DELAY_MS = 5000;

/**
 * @typedef {object} AggregateItem
 * @property {string} phone
 * @property {string} content
 * @property {string} timestamp
 * @property {number} index - SIM 卡索引（+CMT 为 -1）
 * @property {number} _seq - 到达序号（单调递增）
 * @property {string[]} rawLines - 原始 AT 响应
 */

/**
 * @typedef {object} AggregateResult
 * @property {string} phone
 * @property {string} content - 合并后的完整内容
 * @property {string} timestamp - 首条片段的时间戳
 * @property {number[]} indices - 所有片段的 SIM 卡索引
 * @property {string[]} rawParts - 各片段的原始 AT 响应
 * @property {number} parts - 片段数量
 */

/**
 * @callback OnReadyCallback
 * @param {AggregateResult} merged
 */

export class SmsAggregator {
  /**
   * @param {number} delayMs - 聚合窗口，同号码最后一条到达后等多久
   */
  constructor(delayMs = DEFAULT_DELAY_MS) {
    /** @type {Map<string, { items: AggregateItem[], timer: NodeJS.Timeout, callback: OnReadyCallback }>} */
    this._pending = new Map();
    this._delayMs = delayMs;
    /** @type {number} 全局到达序号，用于 +CMT 片段排序 */
    this._seqCounter = 0;
  }

  /**
   * 添加短信到聚合队列
   *
   * 同号码的短信会被缓冲，每次新消息重置定时器。
   * 窗口期内无新消息后，合并所有片段并回调。
   *
   * @param {AggregateItem} item
   * @param {OnReadyCallback} onReady
   */
  add(item, onReady) {
    const key = item.phone;

    if (!this._pending.has(key)) {
      this._pending.set(key, { items: [], timer: null, callback: onReady });
    }

    const entry = this._pending.get(key);
    item._seq = this._seqCounter++;
    entry.items.push(item);
    entry.callback = onReady;

    // 每次收到同号码新消息都延长窗口
    if (entry.timer) clearTimeout(entry.timer);

    entry.timer = setTimeout(() => {
      this._flush(key);
    }, this._delayMs);

    logger.debug(
      { phone: key, pending: entry.items.length },
      '短信已加入聚合队列'
    );
  }

  /**
   * 聚合窗口到期，合并并回调
   * @param {string} key - 号码
   */
  _flush(key) {
    const entry = this._pending.get(key);
    if (!entry) return;

    this._pending.delete(key);

    // 排序策略：
    //   1. SMSC 时间戳（同一长短信分片通常有微妙时间差，先发的片段时间更早）
    //   2. SIM 索引 > 0 时按索引（+CMTI 模式，索引小=先到达）
    //   3. 到达序号兜底（保持网络投递顺序）
    entry.items.sort((a, b) => {
      const tsA = _parseTimestampMs(a.timestamp);
      const tsB = _parseTimestampMs(b.timestamp);
      if (tsA > 0 && tsB > 0 && tsA !== tsB) return tsA - tsB;
      if (a.index >= 0 && b.index >= 0) return a.index - b.index;
      return (a._seq ?? 0) - (b._seq ?? 0);
    });

    const merged = {
      phone: key,
      content: entry.items.map((i) => i.content).join(''),
      timestamp: entry.items[0].timestamp,
      indices: entry.items.map((i) => i.index),
      rawParts: entry.items.map((i) => i.rawLines.join('\n')),
      parts: entry.items.length,
    };

    if (merged.parts > 1) {
      logger.info(
        { phone: key, parts: merged.parts, mergedLength: merged.content.length,
          order: entry.items.map((i) => `seq${i._seq}:idx${i.index}`) },
        '长短信聚合完成'
      );
    }

    entry.callback(merged);
  }
}

/**
 * 解析 SMSC 时间戳为毫秒数
 * 支持 AT 格式 "YY/MM/DD,HH:MM:SS+QQ" 和 ISO 格式
 * @param {string} ts
 * @returns {number} 解析失败返回 0
 */
function _parseTimestampMs(ts) {
  if (!ts) return 0;
  if (ts.includes('T')) return new Date(ts).getTime() || 0;
  const m = ts.match(/(\d{2,4})\D(\d{2})\D(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  let [, year, month, day, hour, min, sec] = m.map(Number);
  if (year < 100) year += 2000;
  return new Date(year, month - 1, day, hour, min, sec).getTime();
}
