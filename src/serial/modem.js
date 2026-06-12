import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import config from '../config/index.js';
import logger from '../logger/index.js';
import { parseCMTI, isURC } from './parser.js';

/**
 * 将字符串编码为 UCS2 hex
 * @param {string} str
 * @returns {string}
 */
function encodeUCS2Hex(str) {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return hex;
}

/**
 * 构建 SMS-SUBMIT PDU（用于 PDU 模式发送中文短信）
 *
 * 文本模式下 CSCS="UCS2" 会导致号码编码冲突，
 * PDU 模式直接构建底层数据帧，绕过 CSCS 限制。
 *
 * @param {string} phone - 目标号码
 * @param {string} content - 短信内容（UCS2 编码）
 * @returns {{ pdu: string, tpduLen: number }}
 */
function buildSmsPdu(phone, content) {
  // SCA: 使用 SIM 卡默认短信中心（长度=0）
  let pdu = '00';

  // First Octet: SMS-SUBMIT, 相对有效期
  // MTI=01, VPF=10 (relative), 其余=0 → 0b00010001 = 0x11
  const tpdu = ['11'];

  // Message Reference: 0（模块自动分配）
  tpdu.push('00');

  // Destination Address
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  const hasPlus = cleanPhone.startsWith('+');
  const digits = hasPlus ? cleanPhone.slice(1) : cleanPhone;
  // DA-Length: 号码位数（semi-octets）
  tpdu.push(digits.length.toString(16).padStart(2, '0').toUpperCase());
  // Type-of-Address: 91=国际格式(+), 81=国内格式
  tpdu.push(hasPlus ? '91' : '81');
  // BCD 编码号码（每两位交换）
  let bcd = '';
  for (let i = 0; i < digits.length; i += 2) {
    const d1 = digits[i];
    const d2 = i + 1 < digits.length ? digits[i + 1] : 'F';
    bcd += d2 + d1;
  }
  tpdu.push(bcd.toUpperCase());

  // PID: 0
  tpdu.push('00');

  // DCS: 0x08 = UCS2
  tpdu.push('08');

  // VP: 相对有效期，0xA7 = 24 小时
  tpdu.push('A7');

  // User Data Length: UCS2 的字节数
  const udBytes = content.length * 2;
  tpdu.push(udBytes.toString(16).padStart(2, '0').toUpperCase());

  // User Data: UCS2 编码内容
  tpdu.push(encodeUCS2Hex(content));

  const tpduHex = tpdu.join('');
  // TPDU 长度 = hex 字符数 / 2
  const tpduLen = tpduHex.length / 2;

  return { pdu: pdu + tpduHex, tpduLen };
}

/**
 * AT 指令队列项
 * @typedef {object} QueueItem
 * @property {string} command
 * @property {(value: string[]) => void} resolve
 * @property {(reason: Error) => void} reject
 * @property {number} timeout
 */

const AT_TIMEOUT = 30_000;

// 重连指数退避参数
const RECONNECT_DELAYS = [5_000, 10_000, 20_000, 30_000];

class Modem extends EventEmitter {
  constructor() {
    super();
    /** @type {SerialPort|null} */
    this._port = null;
    /** @type {ReadlineParser|null} */
    this._parser = null;

    /** @type {QueueItem[]} AT 指令等待队列 */
    this._queue = [];
    /** @type {QueueItem|null} 当前正在执行的指令 */
    this._current = null;
    /** @type {string[]} 当前指令的响应行缓冲 */
    this._responseBuffer = [];
    /** @type {NodeJS.Timeout|null} 当前指令的超时计时器 */
    this._timeoutTimer = null;

    /** @type {number} 重连尝试次数 */
    this._reconnectAttempt = 0;
    /** @type {NodeJS.Timeout|null} 重连计时器 */
    this._reconnectTimer = null;
    /** @type {boolean} 是否正在关闭（优雅退出时不重连） */
    this._closing = false;
  }

  /**
   * 打开串口连接
   * @returns {Promise<void>}
   */
  open() {
    return new Promise((resolve, reject) => {
      if (this._port?.isOpen) {
        resolve();
        return;
      }

      this._port = new SerialPort({
        path: config.serial.port,
        baudRate: config.serial.baudRate,
        autoOpen: false,
      });

      this._parser = this._port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      this._parser.on('data', (line) => this._onLine(line));

      this._port.on('error', (err) => {
        logger.error({ err }, '串口错误');
        this.emit('error', err);
      });

      this._port.on('close', () => {
        logger.warn('串口已断开');
        this.emit('close');
        this._rejectCurrent(new Error('串口断开'));
        if (!this._closing) {
          this._scheduleReconnect();
        }
      });

      this._port.open((err) => {
        if (err) {
          logger.error({ err }, '打开串口失败');
          reject(err);
          return;
        }
        this._reconnectAttempt = 0;
        logger.info({ port: config.serial.port, baudRate: config.serial.baudRate }, '串口已打开');

        // 取消模块可能残留的输入等待状态（如 AT+CMGS 的 ">" 提示）
        // 发送 ESC + Ctrl+Z + 空行，确保模块回到命令模式
        this._port.write('\x1b\x1a\r\n', () => {
          setTimeout(() => resolve(), 500);
        });
      });
    });
  }

  /**
   * 发送 AT 指令并等待响应
   * @param {string} command - AT 指令
   * @param {number} [timeout=AT_TIMEOUT] - 超时时间(ms)
   * @returns {Promise<string[]>} 响应行数组（不含 OK/ERROR）
   */
  send(command, timeout = AT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      this._queue.push({ command, resolve, reject, timeout });
      this._processQueue();
    });
  }

  /**
   * 发送短信
   *
   * 编码策略：
   *   - 纯 ASCII → 文本模式 (CSCS="GSM", 明文)
   *   - 含中文等非 ASCII → PDU 模式 (直接构建数据帧, 绕过 CSCS)
   *
   * Air724UG 文本模式下 CSCS="UCS2" 与号码格式存在兼容问题:
   *   - UCS2 编码号码 → ERROR 304 (号码过长)
   *   - 明文号码 + CSCS="UCS2" → ERROR 518 (格式不一致)
   * PDU 模式不受 CSCS 影响，是发送中文 SMS 的可靠方案。
   *
   * @param {string} phone - 目标号码
   * @param {string} content - 短信内容
   * @returns {Promise<string[]>}
   */
  async sendSms(phone, content) {
    // eslint-disable-next-line no-control-regex
    const needUCS2 = /[^\x00-\x7F]/.test(content);

    if (needUCS2) {
      return this._sendSmsPdu(phone, content);
    }

    // 纯 ASCII: 文本模式，临时切 GSM 字符集
    await this.send('AT+CSCS="GSM"');
    try {
      return await new Promise((resolve, reject) => {
        this._queue.push({
          command: `AT+CMGS="${phone}"`,
          resolve,
          reject,
          timeout: 60_000,
          _smsPayload: content,
        });
        this._processQueue();
      });
    } finally {
      // 恢复 UCS2 字符集，确保后续收短信解析正常
      try { await this.send('AT+CSCS="UCS2"'); } catch { /* ignore */ }
    }
  }

  /**
   * PDU 模式发送短信（用于中文等非 ASCII 内容）
   *
   * 流程:
   *   1. AT+CMGF=0 → 切换到 PDU 模式
   *   2. AT+CMGS=<tpduLen> → 等待 ">" 提示符
   *   3. PDU hex 数据 + \x1a → 等待 OK
   *   4. AT+CMGF=1 → 恢复文本模式
   *
   * @param {string} phone
   * @param {string} content
   * @returns {Promise<string[]>}
   */
  async _sendSmsPdu(phone, content) {
    const { pdu, tpduLen } = buildSmsPdu(phone, content);
    logger.debug({ phone, tpduLen, pduLen: pdu.length }, 'PDU 模式发送短信');

    await this.send('AT+CMGF=0');

    try {
      const result = await new Promise((resolve, reject) => {
        this._queue.push({
          command: `AT+CMGS=${tpduLen}`,
          resolve,
          reject,
          timeout: 60_000,
          _smsPayload: pdu,
        });
        this._processQueue();
      });
      return result;
    } finally {
      // 恢复文本模式（收短信依赖文本模式解析）
      try { await this.send('AT+CMGF=1'); } catch { /* ignore */ }
      // 防御性恢复 UCS2 字符集（某些模块切换 CMGF 可能重置 CSCS）
      try { await this.send('AT+CSCS="UCS2"'); } catch { /* ignore */ }
      // 重新设置 CNMI，确保恢复后短信通知不丢
      try { await this.send('AT+CNMI=2,1,0,0,0'); } catch { /* ignore */ }
    }
  }

  /**
   * 获取串口连接状态
   * @returns {boolean}
   */
  get isConnected() {
    return !!this._port?.isOpen;
  }

  /**
   * 关闭串口
   * @returns {Promise<void>}
   */
  close() {
    this._closing = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._rejectCurrent(new Error('串口正在关闭'));
    // 拒绝队列中所有待执行的指令
    for (const item of this._queue) {
      item.reject(new Error('串口正在关闭'));
    }
    this._queue.length = 0;

    return new Promise((resolve) => {
      if (!this._port?.isOpen) {
        resolve();
        return;
      }
      this._port.close((err) => {
        if (err) {
          logger.warn({ err }, '关闭串口时出错');
        }
        logger.info('串口已关闭');
        resolve();
      });
    });
  }

  /**
   * 处理串口接收到的每一行数据
   * @param {string} line
   */
  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    logger.debug({ line: trimmed }, 'AT 收到');

    // URC 优先处理：不进入命令响应流程
    if (isURC(trimmed)) {
      this._handleURC(trimmed);
      return;
    }

    // 没有正在执行的命令，忽略非 URC 数据
    if (!this._current) return;

    // 命令响应终止符
    if (trimmed === 'OK') {
      this._resolveCurrent(this._responseBuffer.slice());
      return;
    }

    if (trimmed === 'ERROR' || trimmed.startsWith('+CMS ERROR') || trimmed.startsWith('+CME ERROR')) {
      this._rejectCurrent(new Error(`AT 错误: ${trimmed}`));
      return;
    }

    // 命令回显跳过
    if (trimmed === this._current.command) return;

    // 中间结果行
    this._responseBuffer.push(trimmed);
  }

  /**
   * 处理 URC（模块主动上报的事件）
   * @param {string} line
   */
  _handleURC(line) {
    if (line.startsWith('+CMTI:')) {
      const index = parseCMTI(line);
      if (index !== null) {
        logger.info({ index }, '收到新短信通知');
        this.emit('cmti', index);
      }
      return;
    }

    if (line === 'SMSFULL') {
      logger.warn('SIM 卡短信存储已满');
      this.emit('smsfull');
      return;
    }

    logger.debug({ urc: line }, '收到 URC');
  }

  /**
   * 处理 AT 指令队列
   */
  _processQueue() {
    if (this._current || this._queue.length === 0) return;
    if (!this._port?.isOpen) return;

    this._current = this._queue.shift();
    this._responseBuffer = [];

    logger.debug({ command: this._current.command }, 'AT 发送');

    // 设置超时
    this._timeoutTimer = setTimeout(() => {
      this._cleanupRawListener();
      logger.error({ command: this._current?.command }, 'AT 指令超时');
      this._rejectCurrent(new Error(`AT 指令超时: ${this._current?.command}`));
    }, this._current.timeout);

    // AT+CMGS 两阶段：需要监听原始数据捕获 ">" 提示符
    // ReadlineParser 按 \r\n 分割，但 ">" 不以 \r\n 结尾
    if (this._current._smsPayload) {
      this._setupRawListener();
    }

    this._port.write(`${this._current.command}\r\n`, (err) => {
      if (err) {
        this._cleanupRawListener();
        this._rejectCurrent(new Error(`串口写入失败: ${err.message}`));
      }
    });
  }

  /**
   * 注册原始数据监听，捕获 AT+CMGS 的 ">" 提示符
   */
  _setupRawListener() {
    this._rawHandler = (data) => {
      const raw = data.toString();
      if (raw.includes('>') && this._current?._smsPayload) {
        const payload = this._current._smsPayload;
        delete this._current._smsPayload;
        this._cleanupRawListener();
        logger.debug('收到 > 提示符（raw），发送短信内容');
        this._port.write(`${payload}\x1a`, (err) => {
          if (err) {
            this._rejectCurrent(new Error(`短信内容写入失败: ${err.message}`));
          }
        });
      }
    };
    this._port.on('data', this._rawHandler);
  }

  /**
   * 清理原始数据监听
   */
  _cleanupRawListener() {
    if (this._rawHandler) {
      this._port.removeListener('data', this._rawHandler);
      this._rawHandler = null;
    }
  }

  /**
   * 解决当前指令的 Promise
   * @param {string[]} lines
   */
  _resolveCurrent(lines) {
    if (!this._current) return;

    clearTimeout(this._timeoutTimer);
    this._timeoutTimer = null;
    this._cleanupRawListener();

    const { resolve } = this._current;
    this._current = null;
    this._responseBuffer = [];

    resolve(lines);

    // 继续处理下一条指令
    this._processQueue();
  }

  /**
   * 拒绝当前指令的 Promise
   * @param {Error} error
   */
  _rejectCurrent(error) {
    if (!this._current) return;

    clearTimeout(this._timeoutTimer);
    this._timeoutTimer = null;
    this._cleanupRawListener();

    const { reject } = this._current;
    this._current = null;
    this._responseBuffer = [];

    reject(error);

    this._processQueue();
  }

  /**
   * 调度自动重连（指数退避）
   */
  _scheduleReconnect() {
    const delay = RECONNECT_DELAYS[
      Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)
    ];
    this._reconnectAttempt++;

    logger.info({ attempt: this._reconnectAttempt, delay }, '等待重连...');

    this._reconnectTimer = setTimeout(async () => {
      try {
        logger.info({ attempt: this._reconnectAttempt }, '尝试重连串口');
        await this.open();
        this.emit('reconnect');
      } catch {
        this._scheduleReconnect();
      }
    }, delay);
  }
}

export default new Modem();
