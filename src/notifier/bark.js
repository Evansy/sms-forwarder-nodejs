import axios from 'axios';
import config from '../config/index.js';
import logger from '../logger/index.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 2_000;

/**
 * 格式化 Bark 推送内容
 * @param {{ phone: string, content: string, otp: string|null }} message
 * @returns {{ title: string, body: string }}
 */
function formatMessage(message) {
  const { phone, content, otp } = message;

  const title = otp
    ? `验证码: ${otp}`
    : '收到短信';

  const body = otp
    ? `号码: ${phone}\n验证码: ${otp}\n\n${content}`
    : `号码: ${phone}\n\n${content}`;

  return { title, body };
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送 Bark 推送通知（使用 V2 API）
 * @param {{ phone: string, content: string, otp: string|null }} message
 * @returns {Promise<boolean>}
 */
async function send(message) {
  const { title, body } = formatMessage(message);
  const { serverUrl, key, group } = config.bark;

  const payload = {
    device_key: key,
    title,
    body,
    group,
    // 验证码设为时效性通知，可穿透勿扰模式
    level: message.otp ? 'timeSensitive' : 'active',
    // 有验证码时自动复制
    ...(message.otp && {
      autoCopy: '1',
      copy: message.otp,
    }),
  };

  const url = `${serverUrl}/push`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.post(url, payload, {
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });

      if (resp.data?.code === 200) {
        logger.info({ phone: message.phone, otp: message.otp }, 'Bark 通知发送成功');
        return true;
      }

      logger.warn({ attempt, resp: resp.data }, 'Bark 接口返回非 200');
    } catch (err) {
      logger.warn({ attempt, err: err.message }, 'Bark 通知发送失败');
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY);
    }
  }

  logger.error({ phone: message.phone }, `Bark 通知发送失败，已重试 ${MAX_RETRIES} 次`);
  return false;
}

/** @type {import('./feishu.js').Notifier} */
export default { send };
