import { Router } from 'express';
import { queryMessages, getMessageById, insertSentSms } from '../database/sqlite.js';
import modem from '../serial/modem.js';
import config from '../config/index.js';
import logger from '../logger/index.js';

const router = Router();

/**
 * 历史消息列表（分页）
 * GET /api/messages?page=1&pageSize=20&phone=xxx
 */
router.get('/api/messages', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const phone = req.query.phone || undefined;

    const result = queryMessages({ page, pageSize, phone });
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'API: 查询消息失败');
    res.status(500).json({ error: '查询失败' });
  }
});

/**
 * 单条消息详情
 * GET /api/messages/:id
 */
router.get('/api/messages/:id', (req, res) => {
  try {
    const msg = getMessageById(parseInt(req.params.id, 10));
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    res.json(msg);
  } catch (err) {
    logger.error({ err }, 'API: 查询消息详情失败');
    res.status(500).json({ error: '查询失败' });
  }
});

/**
 * 发送短信
 * POST /api/sms/send { phone, content }
 */
router.post('/api/sms/send', async (req, res) => {
  const { phone, content } = req.body;

  if (!phone || !content) {
    return res.status(400).json({ error: '号码和内容不能为空' });
  }

  if (!modem.isConnected) {
    return res.status(503).json({ error: '模块未连接' });
  }

  try {
    logger.info({ phone }, 'Web: 发送短信');
    const result = await modem.sendSms(phone, content);
    // 发送成功后记录到数据库
    insertSentSms({ phone, content });
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err, phone }, 'Web: 发送短信失败');
    res.status(500).json({ error: err.message });
  }
});

/**
 * 模块状态
 * GET /api/status
 */
router.get('/api/status', async (req, res) => {
  const status = {
    connected: modem.isConnected,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
  };

  if (!modem.isConnected) {
    return res.json(status);
  }

  try {
    const csqLines = await modem.send('AT+CSQ');
    const csqMatch = csqLines.join(' ').match(/\+CSQ:\s*(\d+),/);
    status.signal = csqMatch ? parseInt(csqMatch[1], 10) : null;
  } catch { /* ignore */ }

  try {
    const cpinLines = await modem.send('AT+CPIN?');
    status.sim = cpinLines.join(' ').includes('READY') ? 'READY' : cpinLines.join(' ');
  } catch { /* ignore */ }

  try {
    const cpmsLines = await modem.send('AT+CPMS?');
    const cpmsMatch = cpmsLines.join(' ').match(/\+CPMS:\s*"[^"]*",(\d+),(\d+)/);
    if (cpmsMatch) {
      status.smsUsed = parseInt(cpmsMatch[1], 10);
      status.smsTotal = parseInt(cpmsMatch[2], 10);
    }
  } catch { /* ignore */ }

  res.json(status);
});

/**
 * 获取当前配置（脱敏）
 * GET /api/config
 */
router.get('/api/config', (req, res) => {
  res.json({
    serialPort: config.serial.port,
    baudRate: config.serial.baudRate,
    notifier: config.notifier,
    deleteAfterForward: config.sms.deleteAfterForward,
    cnmiRefreshInterval: config.sms.cnmiRefreshInterval,
    logLevel: config.log.level,
  });
});

export default router;
