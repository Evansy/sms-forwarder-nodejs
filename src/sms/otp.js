/**
 * OTP 验证码提取
 *
 * 规则：
 * 1. 优先匹配带关键词上下文的 4~8 位数字
 * 2. 无关键词则 fallback 取第一个 4~8 位数字
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

// 构建关键词正则：关键词附近的 4~8 位数字
// 匹配模式：关键词...数字 或 数字...关键词（中间最多 20 个字符）
const keywordPattern = new RegExp(
  `(?:${OTP_KEYWORDS.join('|')})[^\\d]{0,20}(\\d{4,8})`
  + `|`
  + `(\\d{4,8})[^\\d]{0,20}(?:${OTP_KEYWORDS.join('|')})`,
  'i'
);

// 独立 4~8 位数字（前后不能紧邻其他数字）
const standaloneDigits = /(?<!\d)\d{4,8}(?!\d)/g;

/**
 * 从短信内容中提取 OTP 验证码
 * @param {string} content
 * @returns {{ otp: string|null }}
 */
export function extractOtp(content) {
  if (!content) return { otp: null };

  // 优先：关键词上下文匹配
  const keywordMatch = content.match(keywordPattern);
  if (keywordMatch) {
    const otp = keywordMatch[1] || keywordMatch[2];
    if (otp) return { otp };
  }

  // 降级：取第一个独立的 4~8 位数字
  const fallbackMatch = content.match(standaloneDigits);
  if (fallbackMatch) {
    return { otp: fallbackMatch[0] };
  }

  return { otp: null };
}
