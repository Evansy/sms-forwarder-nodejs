/**
 * 数据库一次性清理脚本
 *
 * 1. 清除 10000 号等运营商号码的虚假 OTP
 * 2. 合并同号码、时间戳相近的截断短信片段
 *
 * 用法: node scripts/db-cleanup.js
 * 建议先备份数据库: cp data/sms.db data/sms.db.bak
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const DB_PATH = resolve('data/sms.db');
const db = new Database(DB_PATH);

// 同号码短信时间戳差距 ≤10 秒视为同一条长短信的片段
const MERGE_WINDOW_MS = 10_000;

function generateHash(phone, content, receivedAt) {
  return createHash('sha256')
    .update(`${phone}|${content}|${receivedAt}`)
    .digest('hex');
}

// ─── Step 1: 清除运营商号码的虚假 OTP ─────────────────────

const operatorPhones = ['10000', '10010', '10086', '10001'];
const clearResult = db.prepare(`
  UPDATE sms_logs SET otp = NULL
  WHERE phone IN (${operatorPhones.map(() => '?').join(',')})
    AND otp IS NOT NULL
`).run(...operatorPhones);

console.log(`[Step 1] 清除运营商号码虚假 OTP: ${clearResult.changes} 条`);

// ─── Step 2: 合并截断的长短信片段 ────────────────────────

const allIncoming = db.prepare(`
  SELECT * FROM sms_logs
  WHERE direction = 'in'
  ORDER BY phone, created_at
`).all();

// 按号码分组
const phoneGroups = new Map();
for (const msg of allIncoming) {
  if (!phoneGroups.has(msg.phone)) phoneGroups.set(msg.phone, []);
  phoneGroups.get(msg.phone).push(msg);
}

let mergedCount = 0;
let deletedCount = 0;

const updateStmt = db.prepare('UPDATE sms_logs SET content = ?, hash = ?, otp = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM sms_logs WHERE id = ?');

const mergeTransaction = db.transaction(() => {
  for (const [phone, msgs] of phoneGroups) {
    if (msgs.length < 2) continue;

    let i = 0;
    while (i < msgs.length) {
      const group = [msgs[i]];
      let j = i + 1;

      while (j < msgs.length) {
        const t1 = new Date(msgs[j - 1].created_at).getTime();
        const t2 = new Date(msgs[j].created_at).getTime();
        if (!isNaN(t1) && !isNaN(t2) && Math.abs(t2 - t1) <= MERGE_WINDOW_MS) {
          group.push(msgs[j]);
          j++;
        } else {
          break;
        }
      }

      if (group.length > 1) {
        const mergedContent = group.map((m) => m.content).join('');
        const keepId = group[0].id;
        const newHash = generateHash(phone, mergedContent, group[0].received_at || group[0].created_at);

        // 简单 OTP 检查：合并内容中如果包含关键词则提取
        let otp = null;
        const otpMatch = mergedContent.match(
          /(?:验证码|校验码|动态码|code|otp|pin|verify|verification|password|passcode)[^\d]{0,20}(\d{4,8})|(\d{4,8})[^\d]{0,20}(?:验证码|校验码|动态码|code|otp|pin)/i
        );
        if (otpMatch) otp = otpMatch[1] || otpMatch[2];

        updateStmt.run(mergedContent, newHash, otp, keepId);

        for (let k = 1; k < group.length; k++) {
          deleteStmt.run(group[k].id);
          deletedCount++;
        }

        mergedCount++;
        console.log(`  合并 [${phone}] ${group.length} 条片段 → ID ${keepId} (${mergedContent.length} 字符)`);
      }

      i = j;
    }
  }
});

mergeTransaction();

console.log(`[Step 2] 合并截断片段: ${mergedCount} 组, 删除冗余记录 ${deletedCount} 条`);
console.log('\n清理完成。');

db.close();
