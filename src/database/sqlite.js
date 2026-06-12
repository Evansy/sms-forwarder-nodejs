import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import logger from '../logger/index.js';

const DB_DIR = resolve('data');
const DB_PATH = resolve(DB_DIR, 'sms.db');

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL 模式，提升并发读写性能
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sms_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE,
    sms_index INTEGER,
    phone TEXT,
    content TEXT,
    otp TEXT,
    received_at DATETIME,
    forwarded INTEGER DEFAULT 0,
    raw TEXT,
    direction TEXT DEFAULT 'in',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 兼容旧数据库：如果 direction 列不存在则添加
try {
  db.exec('ALTER TABLE sms_logs ADD COLUMN direction TEXT DEFAULT \'in\'');
} catch { /* 列已存在，忽略 */ }

const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO sms_logs (hash, sms_index, phone, content, otp, received_at, forwarded, raw)
  VALUES (@hash, @smsIndex, @phone, @content, @otp, @receivedAt, @forwarded, @raw)
`);

const stmtExistsByHash = db.prepare(`
  SELECT 1 FROM sms_logs WHERE hash = ?
`);

/**
 * 生成短信去重 hash
 * @param {string} phone
 * @param {string} content
 * @param {string} receivedAt
 * @returns {string}
 */
export function generateHash(phone, content, receivedAt) {
  return createHash('sha256')
    .update(`${phone}|${content}|${receivedAt}`)
    .digest('hex');
}

/**
 * 检查短信是否已存在（去重）
 * @param {string} hash
 * @returns {boolean}
 */
export function existsByHash(hash) {
  return !!stmtExistsByHash.get(hash);
}

/**
 * 插入短信记录
 * @param {object} record
 * @param {string} record.hash
 * @param {number} record.smsIndex
 * @param {string} record.phone
 * @param {string} record.content
 * @param {string|null} record.otp
 * @param {string} record.receivedAt
 * @param {number} record.forwarded - 0 未转发, 1 已转发
 * @param {string} record.raw
 * @returns {import('better-sqlite3').RunResult}
 */
export function insertSms(record) {
  return stmtInsert.run(record);
}

const stmtInsertSent = db.prepare(`
  INSERT INTO sms_logs (hash, sms_index, phone, content, otp, received_at, forwarded, raw, direction)
  VALUES (@hash, 0, @phone, @content, NULL, @sentAt, 1, '', 'out')
`);

/**
 * 记录已发送的短信
 * @param {{ phone: string, content: string }} msg
 */
export function insertSentSms({ phone, content }) {
  const sentAt = new Date().toISOString();
  const hash = generateHash(phone, content, sentAt);
  return stmtInsertSent.run({ hash, phone, content, sentAt });
}

// ─── Web 面板查询 ────────────────────────────────────────

// 支持的过滤条件 → SQL WHERE 片段
const FILTER_MAP = {
  forwarded: "forwarded = 1 AND direction = 'in'",
  not_forwarded: "forwarded = 0 AND direction = 'in'",
  otp: "otp IS NOT NULL AND otp != ''",
  sent: "direction = 'out'",
};

/**
 * 分页查询消息记录
 *
 * @param {{ page?: number, pageSize?: number, phone?: string, filter?: string }} opts
 * @param {string} [opts.filter] - all | forwarded | not_forwarded | otp | sent
 * @returns {{ messages: object[], total: number, page: number, pageSize: number }}
 */
export function queryMessages({ page = 1, pageSize = 20, phone, filter } = {}) {
  const offset = (page - 1) * pageSize;
  const conditions = [];
  const params = {};

  if (phone) {
    conditions.push('phone LIKE @phone');
    params.phone = `%${phone}%`;
  }

  if (filter && FILTER_MAP[filter]) {
    conditions.push(FILTER_MAP[filter]);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const messages = db.prepare(`
    SELECT id, phone, content, otp, received_at, forwarded, direction, created_at
    FROM sms_logs ${where}
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset });

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM sms_logs ${where}`);
  const { total } = Object.keys(params).length > 0 ? countStmt.get(params) : countStmt.get();

  return { messages, total, page, pageSize };
}

/**
 * 根据 ID 查询单条消息
 * @param {number} id
 * @returns {object|undefined}
 */
export function getMessageById(id) {
  return db.prepare('SELECT * FROM sms_logs WHERE id = ?').get(id);
}

/**
 * 关闭数据库连接
 */
export function closeDb() {
  try {
    db.close();
    logger.info('数据库连接已关闭');
  } catch (err) {
    logger.error({ err }, '关闭数据库失败');
  }
}

/**
 * 获取原始数据库实例（仅供清理脚本等特殊用途）
 */
export function getDb() {
  return db;
}

export default { generateHash, existsByHash, insertSms, insertSentSms, queryMessages, getMessageById, closeDb, getDb };
