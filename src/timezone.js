// 时区引擎：
// 1) 优先使用 ICS 内嵌 VTIMEZONE，严格按 RFC 5545 处理夏令时切换；
// 2) 内嵌定义缺失时回退到运行环境的 Intl API（支持 IANA 时区名）；
// 3) 两者都不可用时抛出明确告警，绝不静默按 UTC 展开。

import { parseOffset, wallFrameMillis, partsOf } from './datetime.js';

/**
 * 从一个 STANDARD/DAYLIGHT 子组件构造转换规则。
 * DTSTART 的钟面时间按 TZOFFSETFROM 解读，得到切换发生的 UTC 时刻。
 */
function buildRule(node) {
  const startLine = node.props.get('DTSTART')?.[0];
  const dt = startLine ? parseDateTimeValue(startLine) : null;
  const offsetFrom = parseOffset(node.props.get('TZOFFSETFROM')[0].value);
  const offsetTo = parseOffset(node.props.get('TZOFFSETTO')[0].value);
  const rruleLines = node.props.get('RRULE') || [];
  const rrule = rruleLines.length ? rruleLines[0].value : null;
  return {
    name: node.name,
    dt,
    offsetFrom,
    offsetTo,
    rrule,
    // DTSTART 钟面（按 from 偏移解读）对应的 UTC 时刻
    firstUtc: dt ? wallFrameMillis(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s) - offsetFrom * 60000 : null,
  };
}

function parseDateTimeValue(line) {
  // 轻量日期解析（VTIMEZONE 的 DTSTART 不带 TZID，按本地钟面处理）
  const v = line.value;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(v);
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: m[4] ? Number(m[4]) : 0,
    mi: m[5] ? Number(m[5]) : 0,
    s: m[6] ? Number(m[6]) : 0,
  };
}

/** 把 RRULE 值字符串拆成大写键的 Map */
function parseRruleMap(value) {
  const map = new Map();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  return map;
}

/**
 * 用 Intl 计算某钟面时间在指定 IANA 时区下的偏移（分钟）。
 * 先按零偏移估算得到所在偏移，再用该偏移重算一次消除误差。
 */
function intlOffset(tzid, wallMillis) {
  const p = partsOf(wallMillis);
  const guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const read = (epoch) => {
    const parts = fmt.formatToParts(new Date(epoch));
    const get = (t) => Number(parts.find((x) => x.type === t).value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'),
      get('hour') % 24, get('minute'), get('second'));
    return Math.round((wall - epoch) / 60000);
  };
  const off1 = read(guess);
  const off2 = read(guess + off1 * 60000);
  return off2;
}

export class TimezoneRegistry {
  constructor() {
    /** @type {Map<string, {source:'vtimezone'|'intl'|'missing', resolver:object, tzid:string}>} */
    this.zones = new Map();
    this.warnings = [];
  }

  /** 注册一棵解析树中的全部 VTIMEZONE */
  registerFromCalendars(calendars) {
    for (const cal of calendars) {
      for (const tzNode of cal.children.filter((c) => c.name === 'VTIMEZONE')) {
        const tzid = tzNode.props.get('TZID')?.[0]?.value;
        if (!tzid) continue;
        const rules = tzNode.children
          .filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT')
          .map(buildRule);
        const resolver = new VTimezoneResolver(tzid, rules);
        this.zones.set(tzid, { source: 'vtimezone', resolver, tzid });
      }
    }
  }

  /**
   * 取得 TZID 对应的解析器；缺失时尝试 Intl 回退。
   * @returns {{offsetForWall:(wallMillis:number)=>number, source:string, tzid:string}|null}
   */
  get(tzid) {
    const hit = this.zones.get(tzid);
    if (hit) return { ...hit.resolver.public(), source: hit.source, tzid };
    if (hasIntlZone(tzid)) {
      const resolver = {
        offsetForWall: (wallMillis) => intlOffset(tzid, wallMillis),
      };
      this.zones.set(tzid, { source: 'intl', resolver, tzid });
      return { ...resolver, source: 'intl', tzid };
    }
    if (!this.zones.has(`__missing__:${tzid}`)) {
      this.warnings.push(`时区 “${tzid}” 在文件中没有 VTIMEZONE 定义，且运行环境不支持该 IANA 时区，相关日程无法确定真实时刻`);
      this.zones.set(`__missing__:${tzid}`, { source: 'missing', resolver: null, tzid });
    }
    return null;
  }
}

function hasIntlZone(tzid) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    // 进一步确认：非法时区名在部分环境下不抛错，用 formatToParts 验证
    new Intl.DateTimeFormat('en-US', { timeZone: tzid }).formatToParts(new Date());
    return true;
  } catch {
    return false;
  }
}

class VTimezoneResolver {
  constructor(tzid, rules) {
    this.tzid = tzid;
    this.rules = rules;
    // 按首次切换时刻排序，便于二分/线性查找
    this.rules.sort((a, b) => a.firstUtc - b.firstUtc);
  }

  /**
   * 给定钟面毫秒框架，返回该当地时间适用的 UTC 偏移（分钟）。
   * 规则（RFC 5545 §3.3.5 思路）：
   *   找到「钟面切换点」不晚于目标钟面的最后一条转换（按钟面比较，不能按 UTC，
   *   否则秋季回拨产生的重叠区间会选错偏移）；
   *   - 落在重叠区（回拨，offsetTo < offsetFrom）：取先经过的旧偏移 offsetFrom；
   *   - 落在间隙（跳针，offsetTo > offsetFrom）：钟面不存在，采用跳变后偏移 offsetTo；
   *   - 其余区间：采用该转换生效后的 offsetTo。
   */
  offsetForWall(wallMillis) {
    const transitions = this.transitionsUpTo(wallMillis);
    if (transitions.length === 0) {
      return this.rules.length ? this.rules[0].offsetFrom : 0;
    }
    // 所有规则（STANDARD + DAYLIGHT）的转换按「钟面起点」统一排序，
    // 再取不晚于目标钟面的最后一条；不能按 UTC 排序，回拨产生的重叠会错位。
    const withWall = transitions
      .map((t) => ({ ...t, wallFrom: t.utc + t.offsetFrom * 60000 }))
      .filter((t) => t.wallFrom <= wallMillis)
      .sort((a, b) => a.wallFrom - b.wallFrom);
    if (withWall.length === 0) return this.rules[0]?.offsetFrom ?? 0;
    const chosen = withWall[withWall.length - 1];
    const wallTo = chosen.utc + chosen.offsetTo * 60000;
    if (wallMillis >= Math.min(chosen.wallFrom, wallTo) &&
        wallMillis < Math.max(chosen.wallFrom, wallTo)) {
      return chosen.offsetTo < chosen.offsetFrom ? chosen.offsetFrom : chosen.offsetTo;
    }
    return chosen.offsetTo;
  }

  /**
   * 生成截止目标钟面前的全部转换实例（含按 RRULE 重复的夏令时规则）。
   * 上限按两侧钟面放宽，保证回拨/跳针附近的转换不会漏算。
   */
  transitionsUpTo(wallMillis) {
    const out = [];
    for (const rule of this.rules) {
      if (!rule.dt) continue;
      const instances = expandRuleTransitions(rule, wallMillis);
      for (const utc of instances) {
        out.push({
          utc,
          offsetFrom: rule.offsetFrom,
          offsetTo: rule.offsetTo,
          kind: rule.name,
        });
      }
    }
    return out;
  }

  public() {
    return {
      offsetForWall: (w) => this.offsetForWall(w),
    };
  }
}

/**
 * 展开单条 STANDARD/DAYLIGHT 规则的历史切换时刻。
 * 无 RRULE 时只有 DTSTART 一次；有 RRULE 时按 FREQ=YEARLY 逐年生成。
 */
function expandRuleTransitions(rule, wallMillis) {
  const baseUtc = rule.firstUtc;
  if (!rule.rrule) return [baseUtc];
  const map = parseRruleMap(rule.rrule);
  if ((map.get('FREQ') || '').toUpperCase() !== 'YEARLY') {
    // 非年度重复的 VTIMEZONE 规则极少见，退回只取首次并告警
    return [baseUtc];
  }
  const until = map.get('UNTIL');
  const count = map.get('COUNT') ? Number(map.get('COUNT')) : Infinity;
  const byMonth = map.get('BYMONTH') ? Number(map.get('BYMONTH')) : rule.dt.mo;
  const byDay = map.get('BYDAY'); // 如 "2SU"、"-1SU"
  const results = [];
  const startYear = rule.dt.y;
  // 上限年份：目标钟面年份 +2 足够覆盖附近的切换
  const limitYear = partsOf(wallMillis).y + 2;
  for (let y = startYear; y <= limitYear && results.length < count; y++) {
    const day = resolveByDay(y, byMonth, byDay, rule.dt);
    if (!day) continue;
    const wall = wallFrameMillis(y, byMonth, day, rule.dt.h, rule.dt.mi, rule.dt.s);
    const utc = wall - rule.offsetFrom * 60000;
    if (until && utc > parseUntilUtc(until)) break;
    results.push(utc);
  }
  return results;
}

function resolveByDay(y, month, byDay, fallback) {
  if (!byDay) return fallback.d;
  // BYDAY 序号可为 2 / +2 / -1，均需支持
  const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(byDay);
  if (!m) return fallback.d;
  const codes = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const wd = codes[m[2]];
  const ord = m[1] ? Number(m[1]) : null;
  const dim = new Date(Date.UTC(y, month, 0)).getUTCDate();
  const matches = [];
  for (let d = 1; d <= dim; d++) {
    if (new Date(Date.UTC(y, month - 1, d)).getUTCDay() === wd) matches.push(d);
  }
  if (ord === null) return matches[0];
  if (ord > 0) return matches[ord - 1];
  return matches[matches.length + ord];
}

function parseUntilUtc(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  if (!m) return Infinity;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]));
}
