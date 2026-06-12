/**
 * Web 面板独立测试脚本（无需串口设备）
 * 注入模拟数据到 SQLite，然后启动 Web 服务器
 *
 * 覆盖场景：
 * - 已转发/未转发短信
 * - 验证码短信（OTP）
 * - 已发送短信
 * - 运营商长短信片段（模拟截断 + 合并后的完整版）
 * - 不同年份的时间戳
 *
 * 用法: node test-web.js
 */

import { insertSms, insertSentSms, generateHash } from './src/database/sqlite.js';
import { startWebServer, broadcast } from './src/web/server.js';

// ─── 模拟数据 ───

const mockMessages = [
  // 已转发 + 验证码
  { phone: '10010', content: '【中国联通】您的验证码为 847261，5分钟内有效。', otp: '847261', ts: '2026/06/12,09:15:22+32', fwd: 1 },
  { phone: '12381', content: '【工信部】验证码 392015，用于手机号码一键登录，请勿泄露。', otp: '392015', ts: '2026/06/12,08:20:10+32', fwd: 1 },
  { phone: '106575850010', content: '【支付宝】验证码 7834，您正在登录支付宝，请勿将验证码告知他人。', otp: '7834', ts: '2026/06/11,14:22:18+32', fwd: 1 },

  // 已转发 + 无验证码
  { phone: '95588', content: '【工商银行】您尾号 8234 的账户于 06月11日 09:30 支出 ¥128.00，余额 ¥5,234.56。', otp: null, ts: '2026/06/11,09:30:45+32', fwd: 1 },
  { phone: '106902180001', content: '【美团】您的外卖订单已由骑手取餐，预计 15:30 送达。订单号 MT20260611001。', otp: null, ts: '2026/06/10,15:05:00+32', fwd: 1 },

  // 未转发（模拟通知失败）
  { phone: '95566', content: '【中国银行】您尾号 9901 的信用卡于 06月10日消费 ¥299.00，可用额度 ¥18,701.00。', otp: null, ts: '2026/06/10,12:10:33+32', fwd: 0 },
  { phone: '10086', content: '您好，您办理的 5G 畅享套餐已生效，月租 129 元。如有疑问请致电 10086。', otp: null, ts: '2026/06/09,16:45:30+32', fwd: 0 },

  // 运营商长短信（已合并的完整版，模拟聚合器输出）
  { phone: '10000', content: '【中国电信10000号】包含当前话费余额、账号余额及本月余额查询https://im.189.cn/t/sxefn?id=bcb6jqsg&expirationFlag=1', otp: null, ts: '2026/06/11,10:30:00+32', fwd: 1 },

  // 去年的短信（测试年份显示）
  { phone: '10086', content: '尊敬的用户，您 2025 年度账单已生成，请登录掌上营业厅查看。', otp: null, ts: '2025/12/31,10:00:00+32', fwd: 1 },

  // 模拟截断片段 —— 这两条在 DB 里是分开的，用来验证清理脚本
  { phone: '95533', content: '【建设银行】您尾号1234的储蓄卡于06月12日10:00收到转账', otp: null, ts: '2026/06/12,10:00:01+32', fwd: 1 },
  { phone: '95533', content: '人民币500.00元，余额12345.67元。', otp: null, ts: '2026/06/12,10:00:02+32', fwd: 0 },
];

let inserted = 0;
for (const msg of mockMessages) {
  const hash = generateHash(msg.phone, msg.content, msg.ts);
  try {
    insertSms({
      hash,
      smsIndex: 0,
      phone: msg.phone,
      content: msg.content,
      otp: msg.otp,
      receivedAt: msg.ts,
      forwarded: msg.fwd,
      raw: `+CMGR: "REC READ","${msg.phone}","","${msg.ts}"\n${msg.content}`,
    });
    inserted++;
  } catch { /* 已存在则忽略 */ }
}

// 模拟已发送短信
try {
  insertSentSms({ phone: '18107554722', content: '测试发送短信，确认收到了吗？' });
  insertSentSms({ phone: '13800138000', content: 'Hello from SMS Forwarder!' });
  inserted += 2;
} catch { /* 已存在则忽略 */ }

console.log(`已注入 ${inserted} 条模拟短信`);

// 启动 Web 服务器
startWebServer();

// ─── 模拟实时短信推送 ───

let counter = 0;

// 模拟普通短信（每 15 秒）
setInterval(() => {
  counter++;
  const mockSms = {
    phone: '1069' + Math.floor(Math.random() * 9000 + 1000),
    content: `【测试】这是第 ${counter} 条模拟实时短信`,
    otp: null,
    timestamp: new Date().toISOString(),
    forwarded: Math.random() > 0.3,
  };
  broadcast('sms', mockSms);

  broadcast('log', {
    level: ['info', 'warn', 'debug'][Math.floor(Math.random() * 3)],
    time: Date.now(),
    msg: `处理短信 #${counter} 来自 ${mockSms.phone}`,
  });
}, 15000);

// 模拟长短信合并场景（启动 8 秒后触发一次）
setTimeout(() => {
  console.log('模拟长短信合并推送...');

  // 聚合器输出的合并结果
  const mergedSms = {
    phone: '10000',
    content: '【中国电信】尊敬的用户，您本月账单已出：话费56.00元，流量费20.00元，短信费3.00元，总计79.00元。请于2026年7月1日前缴费。详情请登录中国电信APP查看。',
    otp: null,
    timestamp: new Date().toISOString(),
    forwarded: true,
  };
  broadcast('sms', mergedSms);

  broadcast('log', {
    level: 'info',
    time: Date.now(),
    msg: '长短信已合并 phone=10000 parts=3 mergedLength=' + mergedSms.content.length,
  });
}, 8000);

// 模拟验证码即时推送（启动 5 秒后触发一次）
setTimeout(() => {
  console.log('模拟验证码即时推送...');

  const otpSms = {
    phone: '106575850010',
    content: '【支付宝】验证码 918273，您正在修改支付密码，请勿泄露给他人。',
    otp: '918273',
    timestamp: new Date().toISOString(),
    forwarded: true,
  };
  broadcast('sms', otpSms);

  broadcast('log', {
    level: 'info',
    time: Date.now(),
    msg: '检测到验证码，立即推送 phone=106575850010 otp=918273',
  });
}, 5000);

console.log('Web 面板测试服务器已启动: http://localhost:3000');
console.log('  5s 后模拟验证码即时推送');
console.log('  8s 后模拟长短信合并推送');
console.log('  每 15s 推送一条随机短信');
