import axios from 'axios';
import config from '../config/index.js';
import logger from '../logger/index.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 2_000;

/**
 * 格式化飞书消息文本
 * @param {{ phone: string, content: string, otp: string|null }} message
 * @returns {string}
 */
function formatMessage(message) {
  const { phone, content, otp } = message;

  if (otp) {
    return [
      '📩 收到短信',
      `号码:\n${phone}`,
      `验证码:\n${otp}`,
      `内容:\n${content}`,
    ].join('\n\n');
  }

  return [
    '📩 收到短信',
    `号码:\n${phone}`,
    `内容:\n${content}`,
  ].join('\n\n');
}

/**
 * 延迟
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送飞书通知
 * @param {{ phone: string, content: string, otp: string|null }} message
 * @returns {Promise<boolean>} 是否发送成功
 */
async function send(message) {
  const text = formatMessage(message);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.post(config.feishu.webhook, {
        msg_type: 'text',
        content: { text },
      }, {
        timeout: 10_000,
      });

      if (resp.data?.code === 0 || resp.data?.StatusCode === 0) {
        logger.info({ phone: message.phone, otp: message.otp }, '飞书通知发送成功');
        return true;
      }

      logger.warn({ attempt, resp: resp.data }, '飞书接口返回非零状态');
    } catch (err) {
      logger.warn({ attempt, err: err.message }, '飞书通知发送失败');
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY);
    }
  }

  logger.error({ phone: message.phone }, `飞书通知发送失败，已重试 ${MAX_RETRIES} 次`);
  return false;
}

/** @type {import('./feishu.js').Notifier} */
export default { send };

/**
 * @typedef {object} Notifier
 * @property {(message: { phone: string, content: string, otp: string|null }) => Promise<boolean>} send
 */
