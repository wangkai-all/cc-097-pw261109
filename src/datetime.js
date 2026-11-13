// 日期时间基础工具：统一用「钟面分量」与「UTC 框架毫秒数」表示当地时间，
// 真正的时区换算由 timezone.js 完成。本模块不引入任何第三方库。

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** 把钟面分量当作 UTC 日期计算毫秒数（仅作比较/排序的框架，不是真实时刻） */
export function wallFrameMillis(y, mo, d, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** 解析后的 dateTime 结构 → 钟面毫秒框架 */
export function wallFrameOf(dt) {
  if (dt.kind === 'date') {
    const [y, mo, d] = dt.date.split('-').map(Number);
    return wallFrameMillis(y, mo, d);
  }
  const [y, mo, d] = dt.date.split('-').map(Number);
  return wallFrameMillis(y, mo, d, dt.hour, dt.minute, dt.second);
}

/** 毫秒框架 → 分量对象 */
export function partsOf(millis) {
  const d = new Date(millis);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

export function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export function weekdayOf(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
export function weekdayCode(name) {
  return WEEKDAYS[name];
}

/** ISO "YYYYMMDD" 风格偏移量 → 分钟（"+0530" / "-0400"） */
export function parseOffset(s) {
  const m = /^([+-])(\d{2})(\d{2})(?:(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`无法解析 UTC 偏移: ${s}`);
  const v = Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 60 : 0);
  return m[1] === '-' ? -v : v;
}

/** 分钟偏移 → "+05:30" 形式 */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `GMT${sign}${h}:${m}`;
}

/**
 * 解析 RFC 5545 DURATION（如 "PT1H30M"、"P1W"、"P1D"）→ 秒
 */
export function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) throw new Error(`无法解析 DURATION: ${value}`);
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = Number(m[2] || 0);
  const days = Number(m[3] || 0);
  const hours = Number(m[4] || 0);
  const mins = Number(m[5] || 0);
  const secs = Number(m[6] || 0);
  return sign * (weeks * 7 * 86400 + days * 86400 + hours * 3600 + mins * 60 + secs);
}

/**
 * 把解析后的 dateTime 换算为真实时刻（epoch 毫秒）。
 * - utc：直接构造
 * - zoned：用 registry 解析该钟面时间适用的 UTC 偏移（含夏令时间隙/重叠规则）
 * - floating：没有真实时刻，按钟面框架返回（渲染时标注「浮动时间」）
 * @returns {{epoch:number, offsetMinutes:number|null, kind:string, tzid?:string}}
 */
export function toInstant(dt, registry) {
  const wall = wallFrameOf(dt);
  if (dt.kind === 'utc') return { epoch: wall, offsetMinutes: 0, kind: 'utc' };
  if (dt.kind === 'floating') return { epoch: wall, offsetMinutes: null, kind: 'floating' };
  if (dt.kind === 'zoned') {
    const resolver = registry.get(dt.tzid);
    if (!resolver) {
      // 找不到时区定义：按钟面框架处理并明确告警，而不是悄悄当作 UTC
      return { epoch: wall, offsetMinutes: null, kind: 'unknown-zone', tzid: dt.tzid };
    }
    const offsetMinutes = resolver.offsetForWall(wall);
    return { epoch: wall - offsetMinutes * MINUTE_MS, offsetMinutes, kind: 'zoned', tzid: dt.tzid };
  }
  if (dt.kind === 'date') return { epoch: wall, offsetMinutes: 0, kind: 'date' };
  throw new Error(`未知 dateTime 类型: ${dt.kind}`);
}

/** 真实时刻 → 指定时区下的钟面分量 */
export function instantToParts(epoch, offsetMinutes) {
  return partsOf(epoch + offsetMinutes * MINUTE_MS);
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 钟面分量 → "YYYY-MM-DD HH:MM" 展示文本 */
export function formatWall(y, mo, d, h, mi, withDate = true) {
  const date = `${y}-${pad2(mo)}-${pad2(d)}`;
  if (h === undefined) return date;
  return withDate ? `${date} ${pad2(h)}:${pad2(mi)}` : `${pad2(h)}:${pad2(mi)}`;
}

/** 生成 "YYYYMMDDTHHMMSS" 形式的本地键，用于 EXDATE/RECURRENCE-ID 匹配 */
export function localKey(y, mo, d, h = null, mi = null, s = null) {
  const date = `${y}${pad2(mo)}${pad2(d)}`;
  if (h === null) return date;
  return `${date}T${pad2(h)}${pad2(mi ?? 0)}${pad2(s ?? 0)}`;
}
