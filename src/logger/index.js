import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import config from '../config/index.js';

const LOG_DIR = resolve('logs');
mkdirSync(LOG_DIR, { recursive: true });

// ─── WebSocket 日志广播 ─────────────────────────────────

/** @type {Array<(entry: object) => void>} */
const logListeners = [];

/**
 * 注册日志监听回调（Web 面板 WebSocket 推送用）
 * @param {(entry: object) => void} cb
 */
export function onLogEntry(cb) {
  logListeners.push(cb);
}

const wsStream = new Writable({
  write(chunk, enc, cb) {
    if (logListeners.length > 0) {
      try {
        const entry = JSON.parse(chunk.toString());
        for (const fn of logListeners) fn(entry);
      } catch { /* ignore */ }
    }
    cb();
  },
});

// ─── 创建 logger ─────────────────────────────────────────
// 使用 multistream 让所有流都在主线程，使 WebSocket 广播可达

const logger = pino(
  { level: config.log.level },
  pino.multistream([
    {
      stream: pinoPretty({
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      }),
      level: config.log.level,
    },
    {
      stream: pino.destination({ dest: resolve(LOG_DIR, 'app.log'), mkdir: true }),
      level: config.log.level,
    },
    {
      stream: wsStream,
      level: config.log.level,
    },
  ])
);

export default logger;
