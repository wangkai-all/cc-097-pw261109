// RRULE (RFC 5545 §3.3.10) 解析与展开引擎。
// 设计原则：
//   - 只在「钟面日期」维度生成候选，时分秒沿用 DTSTART（RRULE 不允许改写钟点，
//     除非使用 BYHOUR 等——本工具对这类规则明确标记为不支持）；
//   - 遇到未实现的规则部分，通过 unsupported[] 明确上报，绝不静默少展开；
//   - 生成器惰性产出，由上层按 COUNT/UNTIL/查询范围截断。

import { daysInMonth, isLeapYear, weekdayCode, weekdayOf } from './datetime.js';

const FREQ_ORDER = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/**
 * 解析 RRULE 内容值（"FREQ=WEEKLY;BYDAY=MO,WE;..."）。
 * @returns {{freq:string, interval:number, count:number|null, until:string|null,
 *   byMonth:number[], byMonthDay:number[], byDay:{ord:number|null, wd:number}[],
 *   bySetPos:number[], wkst:number,
 *   unsupported:string[], raw:string}}
 */
export function parseRRule(value) {
  const map = new Map();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  const unsupported = [];
  const freq = (map.get('FREQ') || '').toUpperCase();
  if (!FREQ_ORDER.includes(freq)) {
    unsupported.push(`FREQ=${map.get('FREQ') || '(缺失)'} 无法识别`);
  }
  if (['SECONDLY', 'MINUTLY', 'MINUTELY', 'HOURLY'].includes(freq)) {
    unsupported.push(`重复频率 FREQ=${freq}（按秒/分/时）暂不支持展开`);
  }
  const numList = (key) => (map.has(key) ? map.get(key).split(',').map(Number) : []);
  const spec = {
    freq,
    interval: map.has('INTERVAL') ? Number(map.get('INTERVAL')) : 1,
    count: map.has('COUNT') ? Number(map.get('COUNT')) : null,
    until: map.get('UNTIL') || null,
    byMonth: numList('BYMONTH'),
    byMonthDay: numList('BYMONTHDAY'),
    byDay: map.has('BYDAY')
      ? map.get('BYDAY').split(',').map((token) => {
          const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
          if (!m) {
            unsupported.push(`BYDAY 项 ${token} 无法识别`);
            return null;
          }
          return { ord: m[1] ? Number(m[1]) : null, wd: weekdayCode(m[2]) };
        }).filter(Boolean)
      : [],
    byYearDay: numList('BYYEARDAY'),
    byWeekNo: numList('BYWEEKNO'),
    byHour: numList('BYHOUR'),
    byMinute: numList('BYMINUTE'),
    bySecond: numList('BYSECOND'),
    bySetPos: numList('BYSETPOS'),
    wkst: map.has('WKST') ? weekdayCode(map.get('WKST')) : 1,
    raw: value,
    unsupported,
  };

  // 明确登记所有暂不支持的规则部分
  if (spec.byYearDay.length) unsupported.push('BYYEARDAY 暂不支持');
  if (spec.byWeekNo.length) unsupported.push('BYWEEKNO 暂不支持');
  if (spec.byHour.length) unsupported.push('BYHOUR（重复规则改写钟点）暂不支持');
  if (spec.byMinute.length) unsupported.push('BYMINUTE（重复规则改写钟点）暂不支持');
  if (spec.bySecond.length) unsupported.push('BYSECOND（重复规则改写钟点）暂不支持');
  if (spec.bySetPos.length) unsupported.push('BYSETPOS 暂不支持');
  if (map.has('RSCALE') || map.has('SKIP')) unsupported.push('RSCALE/SKIP（非公历扩展）暂不支持');

  // 带序号的 BYDAY 只在 MONTHLY/YEARLY 下有定义；WEEKLY/DAILY 下出现序号属于非法输入
  if (spec.byDay.some((b) => b.ord !== null) && (freq === 'WEEKLY' || freq === 'DAILY')) {
    unsupported.push(`FREQ=${freq} 下 BYDAY 不允许带序号（如 2MO）`);
  }
  return spec;
}

/**
 * 日期生成器：从 DTSTART 的钟面日期开始，按 RRULE 惰性产出候选日期 {y,mo,d}。
 * 调用方负责 COUNT/UNTIL/范围截断。
 */
export function* dateGenerator(spec, start) {
  if (spec.unsupported.length) return; // 未支持规则不生成，由上层退化为 DTSTART 单点
  switch (spec.freq) {
    case 'DAILY': yield* daily(spec, start); break;
    case 'WEEKLY': yield* weekly(spec, start); break;
    case 'MONTHLY': yield* monthly(spec, start); break;
    case 'YEARLY': yield* yearly(spec, start); break;
    default: return;
  }
}

function* daily(spec, start) {
  const step = spec.interval;
  let cursor = { y: start.y, mo: start.mo, d: start.d };
  // 安全上限，防止病态规则导致死循环
  for (let i = 0; i < 1_000_000; i++) {
    if (!spec.byDay.length || spec.byDay.some((b) => b.wd === weekdayOf(cursor.y, cursor.mo, cursor.d))) {
      if (matchMonth(cursor, spec)) yield { ...cursor };
    }
    cursor = addDays(cursor, step);
  }
}

function* weekly(spec, start) {
  const step = spec.interval;
  const days = spec.byDay.length ? spec.byDay.map((b) => b.wd).sort((a, b) => a - b) : null;
  // 周期锚点：包含 DTSTART 的那一周（按 WKST 划分）的起始日
  const startWd = weekdayOf(start.y, start.mo, start.d);
  let periodStart = addDays({ y: start.y, mo: start.mo, d: start.d },
    -((startWd - spec.wkst + 7) % 7));
  for (let p = 0; p < 100_000; p++) {
    const weekBase = addDays(periodStart, p * step * 7);
    const candidates = [];
    if (days) {
      for (const wd of days) {
        const offset = (wd - spec.wkst + 7) % 7;
        candidates.push(addDays(weekBase, offset));
      }
    } else {
      candidates.push(addDays(weekBase, (startWd - spec.wkst + 7) % 7));
    }
    candidates.sort((a, b) => keyOf(a) - keyOf(b));
    for (const c of candidates) {
      if (keyOf(c) < keyOf({ y: start.y, mo: start.mo, d: start.d })) continue;
      if (matchMonth(c, spec)) yield c;
    }
  }
}

function* monthly(spec, start) {
  const step = spec.interval;
  for (let offset = 0; offset < 100_000; offset++) {
    const monthCursor = addMonths(start, offset * step);
    const days = monthCandidates(monthCursor, spec);
    for (const d of days) {
      const c = { y: monthCursor.y, mo: monthCursor.mo, d };
      if (keyOf(c) < keyOf(start)) continue;
      if (matchMonth(c, spec)) yield c;
    }
  }
}

function monthCandidates(cursor, spec) {
  const dim = daysInMonth(cursor.y, cursor.mo);
  const days = new Set();
  if (spec.byMonthDay.length) {
    for (const md of spec.byMonthDay) {
      const resolved = md > 0 ? md : dim + md + 1; // 负序号从月末倒数
      if (resolved >= 1 && resolved <= dim) days.add(resolved);
    }
  }
  if (spec.byDay.length) {
    for (const b of spec.byDay) {
      if (b.ord === null) {
        for (let d = 1; d <= dim; d++) {
          if (weekdayOf(cursor.y, cursor.mo, d) === b.wd) days.add(d);
        }
      } else if (b.ord > 0) {
        const d = nthWeekday(cursor.y, cursor.mo, b.wd, b.ord);
        if (d !== null) days.add(d);
      } else {
        const d = nthLastWeekday(cursor.y, cursor.mo, b.wd, -b.ord);
        if (d !== null) days.add(d);
      }
    }
  }
  if (!spec.byMonthDay.length && !spec.byDay.length) days.add(cursor.d);
  return [...days].sort((a, b) => a - b);
}

function* yearly(spec, start) {
  const step = spec.interval;
  for (let offset = 0; offset < 100_000; offset++) {
    const y = start.y + offset * step;
    const months = spec.byMonth.length ? spec.byMonth : [start.mo];
    for (const mo of months) {
      const dim = daysInMonth(y, mo);
      const days = new Set();
      if (spec.byMonthDay.length) {
        for (const md of spec.byMonthDay) {
          const resolved = md > 0 ? md : dim + md + 1;
          if (resolved >= 1 && resolved <= dim) days.add(resolved);
        }
      }
      if (spec.byDay.length) {
        for (const b of spec.byDay) {
          if (b.ord === null) {
            for (let d = 1; d <= dim; d++) {
              if (weekdayOf(y, mo, d) === b.wd) days.add(d);
            }
          } else if (b.ord > 0) {
            const d = nthWeekday(y, mo, b.wd, b.ord);
            if (d !== null) days.add(d);
          } else {
            const d = nthLastWeekday(y, mo, b.wd, -b.ord);
            if (d !== null) days.add(d);
          }
        }
      }
      if (!spec.byMonthDay.length && !spec.byDay.length) days.add(start.d);
      const sorted = [...days].sort((a, b) => a - b);
      for (const d of sorted) {
        const c = { y, mo, d };
        if (keyOf(c) < keyOf(start)) continue;
        yield c;
      }
    }
  }
}

function matchMonth(cursor, spec) {
  return !spec.byMonth.length || spec.byMonth.includes(cursor.mo);
}

function nthWeekday(y, mo, wd, n) {
  const dim = daysInMonth(y, mo);
  let found = 0;
  for (let d = 1; d <= dim; d++) {
    if (weekdayOf(y, mo, d) === wd) {
      found++;
      if (found === n) return d;
    }
  }
  return null;
}

function nthLastWeekday(y, mo, wd, n) {
  const dim = daysInMonth(y, mo);
  let found = 0;
  for (let d = dim; d >= 1; d--) {
    if (weekdayOf(y, mo, d) === wd) {
      found++;
      if (found === n) return d;
    }
  }
  return null;
}

export function addDays(cursor, n) {
  const t = Date.UTC(cursor.y, cursor.mo - 1, cursor.d) + n * 86_400_000;
  const d = new Date(t);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function addMonths(cursor, n) {
  const total = (cursor.y * 12 + cursor.mo - 1) + n;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const d = Math.min(cursor.d, daysInMonth(y, mo));
  return { y, mo, d };
}

function keyOf(c) {
  return c.y * 10000 + c.mo * 100 + c.d;
}

/** 闰年导出供测试使用 */
export { isLeapYear };
