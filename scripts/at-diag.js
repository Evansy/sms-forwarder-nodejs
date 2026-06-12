#!/usr/bin/env node

/**
 * AT 诊断脚本
 *
 * 用法：先停止 sms-forwarder 服务，然后运行：
 *   systemctl stop sms-forwarder
 *   node scripts/at-diag.js
 *
 * 脚本会依次执行一系列 AT 诊断指令并输出结果。
 * 按 Ctrl+C 退出。
 */

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT_PATH = process.env.SERIAL_PORT || '/dev/ttyUSB2';
const BAUD_RATE = Number(process.env.SERIAL_BAUD) || 115200;

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${tag}: ${msg}`);
}

async function main() {
  log('INFO', `打开串口 ${PORT_PATH} @ ${BAUD_RATE}`);

  const port = new SerialPort({ path: PORT_PATH, baudRate: BAUD_RATE, autoOpen: false });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  // 收集所有行
  const lines = [];
  parser.on('data', (line) => {
    const trimmed = line.trim();
    if (trimmed) {
      log('<<', trimmed);
      lines.push(trimmed);
    }
  });

  // 监听原始数据（捕获 > 等非换行结尾的提示符）
  port.on('data', (data) => {
    const raw = data.toString();
    if (raw.includes('>')) {
      log('<<', '> (提示符)');
    }
  });

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  log('INFO', '串口已打开');

  /**
   * 发送 AT 指令并等待响应
   * @param {string} cmd
   * @param {number} waitMs
   */
  async function at(cmd, waitMs = 2000) {
    lines.length = 0;
    log('>>', cmd);
    port.write(`${cmd}\r\n`);
    await sleep(waitMs);
    return lines.slice();
  }

  // ─── 开始诊断 ─────────────────────────────────

  console.log('\n=== AT 基本通信 ===');
  await at('AT');

  console.log('\n=== 字符集 ===');
  await at('AT+CSCS?');

  console.log('\n=== 短信格式 ===');
  await at('AT+CMGF?');

  console.log('\n=== 存储区 ===');
  await at('AT+CPMS?');

  console.log('\n=== SIM 状态 ===');
  await at('AT+CPIN?');

  console.log('\n=== 信号强度 ===');
  await at('AT+CSQ');

  console.log('\n=== CNMI 设置 ===');
  await at('AT+CNMI?');

  // 设置文本模式和存储区
  console.log('\n=== 设置文本模式 ===');
  await at('AT+CMGF=1');

  console.log('\n=== 设置存储区 SM ===');
  await at('AT+CPMS="SM","SM","SM"');

  // 分别用 GSM 和 UCS2 字符集测试
  console.log('\n=== [GSM 模式] 读取全部短信 (CMGL=4) ===');
  await at('AT+CSCS="GSM"');
  await at('AT+CMGL=4', 5000);

  console.log('\n=== [GSM 模式] 读取未读短信 (CMGL=0) ===');
  await at('AT+CMGL=0', 5000);

  console.log('\n=== [GSM 模式] 读取 index=1 ===');
  await at('AT+CMGR=1', 3000);

  console.log('\n=== 切换到 UCS2 ===');
  await at('AT+CSCS="UCS2"');

  console.log('\n=== [UCS2 模式] 读取全部短信 (CMGL=4) ===');
  await at('AT+CMGL=4', 5000);

  console.log('\n=== [UCS2 模式] 读取未读短信 (CMGL=0) ===');
  await at('AT+CMGL=0', 5000);

  console.log('\n=== [UCS2 模式] 读取 index=1 ===');
  await at('AT+CMGR=1', 3000);

  console.log('\n=== 查询所有存储区容量 ===');
  await at('AT+CPMS?');

  console.log('\n=== 尝试 ME 存储 ===');
  await at('AT+CPMS="ME","ME","ME"');
  await at('AT+CMGL=4', 5000);

  // 恢复
  console.log('\n=== 恢复 SM 存储 ===');
  await at('AT+CPMS="SM","SM","SM"');

  console.log('\n=== 诊断完成 ===');
  console.log('请把上面的完整输出发给我分析。');
  console.log('按 Ctrl+C 退出，或等待 30 秒内是否有新短信到达...');

  // 等待 30 秒观察是否有 CMTI
  await sleep(30_000);

  port.close();
}

main().catch((err) => {
  console.error('诊断脚本出错:', err.message);
  process.exit(1);
});
