import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import config from '../config/index.js';
import logger from '../logger/index.js';
import { parseCMTI, isURC } from './parser.js';

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
        resolve();
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
      logger.error({ command: this._current?.command }, 'AT 指令超时');
      this._rejectCurrent(new Error(`AT 指令超时: ${this._current?.command}`));
    }, this._current.timeout);

    this._port.write(`${this._current.command}\r\n`, (err) => {
      if (err) {
        this._rejectCurrent(new Error(`串口写入失败: ${err.message}`));
      }
    });
  }

  /**
   * 解决当前指令的 Promise
   * @param {string[]} lines
   */
  _resolveCurrent(lines) {
    if (!this._current) return;

    clearTimeout(this._timeoutTimer);
    this._timeoutTimer = null;

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
