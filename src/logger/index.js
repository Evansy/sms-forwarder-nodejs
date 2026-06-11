import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import config from '../config/index.js';

const LOG_DIR = resolve('logs');
mkdirSync(LOG_DIR, { recursive: true });

const logger = pino({
  level: config.log.level,
  transport: {
    targets: [
      // 控制台输出（带美化）
      {
        target: 'pino-pretty',
        level: config.log.level,
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
      // 文件输出
      {
        target: 'pino/file',
        level: config.log.level,
        options: {
          destination: resolve(LOG_DIR, 'app.log'),
          mkdir: true,
        },
      },
    ],
  },
});

export default logger;
