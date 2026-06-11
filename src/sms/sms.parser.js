/**
 * 短信内容高层解析
 * 封装 AT 解析器返回的原始数据为统一的短信对象
 */

import { extractOtp } from './otp.js';

/**
 * @typedef {object} ParsedSms
 * @property {string} phone - 发送者号码
 * @property {string} content - 短信内容
 * @property {string} timestamp - 接收时间
 * @property {string|null} otp - 提取的验证码
 */

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
    timestamp: raw.timestamp,
    otp,
  };
}
