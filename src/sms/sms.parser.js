/**
 * 短信内容高层解析
 * 封装 AT 解析器返回的原始数据为统一的短信对象
 */

import { extractOtp } from './otp.js';

/**
 * @typedef {object} ParsedSms
 * @property {string} phone - 发送者号码
 * @property {string} content - 短信内容
 * @property {string} timestamp - 接收时间（ISO 格式）
 * @property {string|null} otp - 提取的验证码
 */

/**
 * 将 AT 模块时间戳转换为 ISO 格式
 *
 * AT 格式: "YY/MM/DD,HH:MM:SS+QQ" 或 "YYYY/MM/DD,HH:MM:SS+QQ"
 * 其中 QQ 是 3GPP TS 23.040 规定的"季度小时"时区偏移
 * 例如 +32 = +32×15min = +8h = UTC+8
 *
 * @param {string} ts
 * @returns {string} ISO 格式时间字符串
 */
export function normalizeTimestamp(ts) {
  if (!ts) return new Date().toISOString();
  // 已经是 ISO 格式
  if (ts.includes('T')) return ts;

  const m = ts.match(/(\d{2,4})\D(\d{2})\D(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-])(\d{1,2})/);
  if (!m) return ts;

  let [, year, month, day, hour, min, sec, sign, qh] = m;
  if (year.length === 2) year = '20' + year;

  const quarters = parseInt(qh, 10);
  const tzH = Math.floor(quarters / 4).toString().padStart(2, '0');
  const tzM = ((quarters % 4) * 15).toString().padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:${min}:${sec}${sign}${tzH}:${tzM}`;
}

/**
 * 将 AT 解析结果转换为统一的短信对象
 * @param {{ phone: string, content: string, timestamp: string }} raw
 * @returns {ParsedSms}
 */
export function buildSmsRecord(raw) {
  const { otp } = extractOtp(raw.content);

  return {
    phone: raw.phone,
    content: raw.content,
    timestamp: normalizeTimestamp(raw.timestamp),
    otp,
  };
}
