// ICS (RFC 5545) 解析器：折叠行还原、参数解析、组件嵌套、日期时间解析
// 纯函数实现，浏览器与 Node 均可使用，不依赖任何第三方库。

/**
 * 行展开：RFC 5545 规定折行以 CRLF + 空白符开头，去掉该空白符即还原。
 * 同时容忍单独的 LF/CR 换行。
 * @param {string} text
 * @returns {string[]} 内容行（已展开）
 */
export function unfoldLines(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');
  const out = [];
  for (const line of rawLines) {
    if (line.length === 0) continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * 解析带参数的内容行，例如:
 *   DTSTART;TZID=America/New_York:20260310T090000
 * @param {string} line
 * @returns {{name:string, params:Record<string,string>, value:string, raw:string}}
 */
export function parseContentLine(line) {
  const colon = findTopLevelColon(line);
  const head = colon === -1 ? line : line.slice(0, colon);
  const value = colon === -1 ? '' : line.slice(colon + 1);
  const parts = splitTopLevelSemicolons(head);
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const key = parts[i].slice(0, eq).toUpperCase();
    let val = parts[i].slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value, raw: line };
}

function findTopLevelColon(s) {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) return i;
  }
  return -1;
}

function splitTopLevelSemicolons(s) {
  const out = [];
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ';' && !inQuote) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** TEXT 类型反转义（RFC 5545 §3.3.11） */
export function unescapeText(s) {
  return s
    .replace(/\\[;,\\]/g, (m) => m[1])
    .replace(/\\n/gi, '\n');
}

/**
 * 解析 DATE 或 DATE-TIME 值。
 * 返回统一结构:
 *   { kind:'date', date:'YYYY-MM-DD' }
 *   { kind:'utc',   date:'YYYY-MM-DD', hour,minute,second }
 *   { kind:'zoned', tzid, date, hour,... }   —— 钟面时间，偏移由时区引擎解析
 *   { kind:'floating', date, hour,... }      —— 无时区、按当地钟面处理
 * @param {string} value
 * @param {Record<string,string>} params
 */
export function parseDateTime(value, params = {}) {
  const v = value.trim();
  if (/^\d{8}$/.test(v)) {
    return { kind: 'date', date: ymd(v), isAllDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) throw new Error(`无法解析的日期时间值: ${value}`);
  const base = {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  if (m[7] === 'Z') return { kind: 'utc', ...base };
  if (params.TZID) return { kind: 'zoned', tzid: params.TZID, ...base };
  return { kind: 'floating', ...base };
}

function ymd(v) {
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/**
 * 解析整份 ICS 文本为组件树。
 * 节点结构: { name, props: Map<name, contentLine[]>, children: node[], lines: string[] }
 * @param {string} text
 * @returns {{calendars: object[], warnings: string[]}}
 */
export function parseICS(text) {
  const warnings = [];
  const lines = unfoldLines(text).filter((l) => l.length > 0);
  const root = { name: '$ROOT', props: new Map(), children: [], lines: [] };
  const stack = [root];
  for (const line of lines) {
    if (/^BEGIN[;:]/i.test(line)) {
      const cl = parseContentLine(line);
      const node = { name: cl.value.toUpperCase(), props: new Map(), children: [], lines: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (/^END[;:]/i.test(line)) {
      const cl = parseContentLine(line);
      const top = stack.pop();
      if (!top || top.name !== cl.value.toUpperCase()) {
        warnings.push(`BEGIN/END 不匹配: ${line}`);
        stack.push(top || root);
      }
    } else {
      const cl = parseContentLine(line);
      const cur = stack[stack.length - 1];
      if (!cur.props.has(cl.name)) cur.props.set(cl.name, []);
      cur.props.get(cl.name).push(cl);
      cur.lines.push(line);
    }
  }
  if (stack.length !== 1) warnings.push('部分组件缺少 END');
  const calendars = root.children.filter((c) => c.name === 'VCALENDAR');
  if (calendars.length === 0) warnings.push('未找到 VCALENDAR 组件');
  return { calendars, warnings };
}

/** 读取组件上的单个属性（取第一个） */
export function prop(node, name) {
  const list = node.props.get(name.toUpperCase());
  return list ? list[0] : undefined;
}

/** 读取组件上的同名全部属性 */
export function props(node, name) {
  return node.props.get(name.toUpperCase()) || [];
}

/** 读取 TEXT 属性并反转义 */
export function textProp(node, name) {
  const p = prop(node, name);
  return p ? unescapeText(p.value) : undefined;
}
