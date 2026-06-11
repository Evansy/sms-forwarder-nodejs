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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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

export default { generateHash, existsByHash, insertSms, closeDb };
