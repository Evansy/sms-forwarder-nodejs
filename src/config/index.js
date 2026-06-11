import "dotenv/config";

/** @type {Readonly<AppConfig>} */
const config = Object.freeze({
  // 通知渠道: bark | feishu
  notifier: process.env.NOTIFIER || "bark",
  serial: {
    port: process.env.SERIAL_PORT || "/dev/ttyUSB0",
    baudRate: parseInt(process.env.BAUD_RATE, 10) || 115200,
  },
  bark: {
    serverUrl: (process.env.BARK_SERVER_URL || "https://api.day.app").replace(
      /\/$/,
      "",
    ),
    key: process.env.BARK_KEY || "",
    group: process.env.BARK_GROUP || "sms",
  },
  feishu: {
    webhook: process.env.FEISHU_WEBHOOK || "",
  },
  sms: {
    deleteAfterForward: process.env.DELETE_SMS_AFTER_FORWARD !== "false",
    cnmiRefreshInterval:
      parseInt(process.env.CNMI_REFRESH_INTERVAL, 10) || 60_000,
  },
  log: {
    level: process.env.LOG_LEVEL || "info",
  },
});

const VALID_NOTIFIERS = ["bark", "feishu"];

/**
 * 校验必要配置项，缺失则抛出错误
 */
export function validateConfig() {
  if (!config.serial.port) {
    throw new Error("SERIAL_PORT is required");
  }

  if (!VALID_NOTIFIERS.includes(config.notifier)) {
    throw new Error(`NOTIFIER must be one of: ${VALID_NOTIFIERS.join(", ")}`);
  }

  if (config.notifier === "bark" && !config.bark.key) {
    throw new Error("BARK_KEY is required when NOTIFIER=bark");
  }

  if (config.notifier === "feishu" && !config.feishu.webhook) {
    throw new Error("FEISHU_WEBHOOK is required when NOTIFIER=feishu");
  }
}

export default config;

/**
 * @typedef {object} AppConfig
 * @property {string} notifier
 * @property {{ port: string, baudRate: number }} serial
 * @property {{ serverUrl: string, key: string, group: string }} bark
 * @property {{ webhook: string }} feishu
 * @property {{ deleteAfterForward: boolean, cnmiRefreshInterval: number }} sms
 * @property {{ level: string }} log
 */
