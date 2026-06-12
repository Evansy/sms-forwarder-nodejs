/**
 * AT 响应解析器
 * 负责解析 +CMTI, +CMGR, +CMGL 等 AT 响应
 * 支持 UCS2 hex 编码自动检测与解码
 */

// ─── UCS2 编码工具 ────────────────────────────────────────

/**
 * 检测字符串是否为 UCS2 hex 编码
 * 判据：全部是 hex 字符、长度为 4 的倍数、且长度 > 正常文本预期
 * 对于号码：UCS2 编码后长度远超正常号码（10位号码→40位hex）
 * @param {string} str
 * @returns {boolean}
 */
function isUCS2Hex(str) {
  return (
    str.length >= 8
    && str.length % 4 === 0
    && /^[0-9A-Fa-f]+$/.test(str)
  );
}

/**
 * 解码 UCS2 hex 字符串为 UTF-16 文本
 * 正确处理 surrogate pair（emoji 等 BMP 之外的字符）
 * @param {string} hex
 * @returns {string}
 */
function decodeUCS2Hex(hex) {
  const codeUnits = [];
  for (let i = 0; i < hex.length; i += 4) {
    codeUnits.push(parseInt(hex.substring(i, i + 4), 16));
  }
  return String.fromCharCode(...codeUnits);
}

/**
 * 如果输入是 UCS2 hex 则解码，否则原样返回
 * @param {string} str
 * @returns {string}
 */
export function autoDecodeUCS2(str) {
  if (!str || !isUCS2Hex(str)) return str;
  try {
    return decodeUCS2Hex(str);
  } catch {
    return str;
  }
}

// ─── AT 响应解析 ────────────────────────────────────────

/**
 * 解析 +CMTI 新短信通知
 * 输入: +CMTI: "SM",15
 * 输出: 15
 * @param {string} line
 * @returns {number|null}
 */
export function parseCMTI(line) {
  const match = line.match(/\+CMTI:\s*"[^"]*",\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 解析 +CMT 短信直接投递的头行
 *
 * CNMI mt=2 时模块直接推送短信内容（不存入 SIM），格式：
 *   +CMT: "phone","name","timestamp"
 *   <content>
 *
 * UCS2 模式下 phone 为 hex 编码
 *
 * @param {string} line - +CMT 头行
 * @returns {{ phone: string, timestamp: string, _ucs2: boolean } | null}
 */
export function parseCMTHeader(line) {
  // 兼容 name 为空（,, 或 "",）
  const match = line.match(/\+CMT:\s*"([^"]*)",\s*(?:"[^"]*")?,\s*"([^"]*)"/);
  if (!match) return null;

  const [, rawPhone, timestamp] = match;
  const ucs2Mode = isUCS2Hex(rawPhone);
  const phone = ucs2Mode ? decodeUCS2Hex(rawPhone) : rawPhone;

  return { phone, timestamp, _ucs2: ucs2Mode };
}

/**
 * 解析 +CMGR 短信读取响应
 *
 * 兼容两种格式：
 *   标准:  +CMGR: "REC UNREAD","+447123456789","","26/06/11,12:00:00+08"
 *   UCS2:  +CMGR: "REC UNREAD","003100380036...",,"2026/06/11,16:40:11+32"
 *
 * @param {string[]} lines - AT+CMGR 的完整响应行（不含 OK）
 * @returns {{ status: string, phone: string, timestamp: string, content: string } | null}
 */
export function parseCMGR(lines) {
  if (!lines || lines.length === 0) return null;

  const headerIdx = lines.findIndex((l) => l.startsWith('+CMGR:'));
  if (headerIdx === -1) return null;

  const headerLine = lines[headerIdx];

  // 兼容 name 字段为空（,, 或 "",）的情况
  const headerMatch = headerLine.match(
    /\+CMGR:\s*"([^"]*)",\s*"([^"]*)",\s*(?:"[^"]*")?,\s*"([^"]*)"/
  );
  if (!headerMatch) return null;

  const [, status, rawPhone, timestamp] = headerMatch;

  // UCS2 检测：如果号码是 hex 编码，内容也是
  const ucs2Mode = isUCS2Hex(rawPhone);
  const phone = ucs2Mode ? decodeUCS2Hex(rawPhone) : rawPhone;

  // 短信内容是 +CMGR 头行之后的所有行
  const contentLines = lines.slice(headerIdx + 1);
  // UCS2 模式下内容是连续 hex，多行应无分隔符拼接
  const rawContent = contentLines.join(ucs2Mode ? '' : '\n').trim();
  const content = ucs2Mode ? autoDecodeUCS2(rawContent) : rawContent;

  return { status, phone, timestamp, content };
}

/**
 * 解析 +CMGL 短信列表响应（用于启动时扫描未读短信）
 *
 * 兼容两种格式：
 *   标准:  +CMGL: 0,"REC UNREAD","+447123456789","","26/06/11,12:00:00+08"
 *   UCS2:  +CMGL: 0,"REC UNREAD","003100380036...",,"2026/06/11,16:40:11+32"
 *
 * @param {string[]} lines - AT+CMGL 的完整响应行（不含 OK）
 * @returns {Array<{ index: number, status: string, phone: string, timestamp: string, content: string }>}
 */
export function parseCMGL(lines) {
  if (!lines || lines.length === 0) return [];

  const results = [];
  let current = null;
  const contentBuf = [];

  for (const line of lines) {
    // 兼容 name 字段为空（,, 或 "",）
    const headerMatch = line.match(
      /\+CMGL:\s*(\d+),\s*"([^"]*)",\s*"([^"]*)",\s*(?:"[^"]*")?,\s*"([^"]*)"/
    );

    if (headerMatch) {
      // 保存前一条短信
      if (current) {
        current.content = finalizeContent(contentBuf, current._ucs2);
        results.push(current);
        contentBuf.length = 0;
      }

      const [, index, status, rawPhone, timestamp] = headerMatch;
      const ucs2Mode = isUCS2Hex(rawPhone);

      current = {
        index: parseInt(index, 10),
        status,
        phone: ucs2Mode ? decodeUCS2Hex(rawPhone) : rawPhone,
        timestamp,
        content: '',
        _ucs2: ucs2Mode,
      };
    } else if (current) {
      contentBuf.push(line);
    }
  }

  // 保存最后一条
  if (current) {
    current.content = finalizeContent(contentBuf, current._ucs2);
    results.push(current);
  }

  // 清理内部标记
  for (const msg of results) {
    delete msg._ucs2;
  }

  return results;
}

/**
 * 合并内容行并按需解码 UCS2
 * @param {string[]} buf
 * @param {boolean} ucs2
 * @returns {string}
 */
function finalizeContent(buf, ucs2) {
  const raw = buf.join(ucs2 ? '' : '\n').trim();
  return ucs2 ? autoDecodeUCS2(raw) : raw;
}

/**
 * 检测是否为 URC（Unsolicited Result Code）
 * URC 是模块主动上报的事件，不是 AT 指令的响应。
 * 必须准确识别，否则 URC 会混入 AT 响应缓冲区，破坏 CMGR/CMGL 解析。
 * @param {string} line
 * @returns {boolean}
 */
export function isURC(line) {
  return (
    line.startsWith('+CMTI:') ||
    line.startsWith('+CMT:') ||
    line === 'SMS READY' ||
    line === 'SMSFULL' ||
    line.startsWith('+CIEV:') ||
    // Air724UG LTE 测量报告（约每 8 秒一组，必须过滤）
    line.startsWith('+EEMLTESVC:') ||
    line.startsWith('+EEMLTEINTRA:') ||
    line.startsWith('+EEMLTEINTER:') ||
    line.startsWith('+EEMGSMINTER:') ||
    line.startsWith('+EEMGSMINTRA:') ||
    line.startsWith('+EEMUMTSINTER:') ||
    line.startsWith('+EEMUMTSINTRA:')
  );
}
