import { resolve } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import config from '../config/index.js';
import logger, { onLogEntry } from '../logger/index.js';
import routes from './routes.js';

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

/**
 * 启动 Web 服务器（HTTP + WebSocket）
 * @returns {{ app: express.Application, wss: WebSocketServer }}
 */
export function startWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(resolve('public')));
  app.use(routes);

  const port = config.web.port;
  const server = app.listen(port, () => {
    logger.info({ port }, 'Web 面板已启动');
  });

  // WebSocket 服务
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    logger.debug('WebSocket 客户端已连接');

    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });

  // 日志推送到 Web 面板
  onLogEntry((entry) => {
    broadcast('log', entry);
  });

  return { app, wss };
}

/**
 * 向所有 WebSocket 客户端广播消息
 * @param {string} type - 消息类型 (sms | log)
 * @param {object} data - 消息数据
 */
export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}
