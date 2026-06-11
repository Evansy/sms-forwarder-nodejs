/**
 * OTP 验证码提取
 *
 * 规则：
 * 仅在短信内容包含验证码关键词时提取附近的 4~8 位数字
 * 不再做无关键词的 fallback，避免运营商号码（10000）、金额等被误识别
 */

// 验证码关键词（中英文）
const OTP_KEYWORDS = [
  'code',
  'otp',
  'pin',
  'verify',
  'verification',
  'password',
  'passcode',
  '验证码',
  '校验码',
  '动态码',
  '认证码',
];

// 关键词...数字 或 数字...关键词（中间最多 20 个字符）
const keywordPattern = new RegExp(
  `(?:${OTP_KEYWORDS.join('|')})[^\\d]{0,20}(\\d{4,8})`
  + `|`
  + `(\\d{4,8})[^\\d]{0,20}(?:${OTP_KEYWORDS.join('|')})`,
  'i'
);

/**
 * 从短信内容中提取 OTP 验证码
 * @param {string} content
 * @returns {{ otp: string|null }}
 */
export function extractOtp(content) {
  if (!content) return { otp: null };

  const keywordMatch = content.match(keywordPattern);
  if (keywordMatch) {
    const otp = keywordMatch[1] || keywordMatch[2];
    if (otp) return { otp };
  }

  return { otp: null };
}
