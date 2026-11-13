// 展开引擎：把解析后的 VEVENT 集合变成「每一次实际发生的日程」。
//
// 处理顺序：
//   1. 按 UID 分组，依据 SEQUENCE / DTSTAMP / LAST-MODIFIED 挑选主版本，
//      METHOD=CANCEL 或 STATUS=CANCELLED 的整组事件标记为取消；
//   2. RECURRENCE-ID 例外记录挂到所属主事件，单次取消只删对应那一次；
//   3. RRULE 生成候选，EXDATE 排除、RDATE 补充、例外记录覆盖；
//   4. 按查询范围过滤（调整范围只影响查询，不改写原始日历）；
//   5. 所有未支持规则与异常数据进入 warnings，实例上也带来源信息。

import { parseICS, parseDateTime, prop, props, textProp, unescapeText } from './parser.js';
import { parseRRule, dateGenerator, addDays } from './rrule.js';
import { TimezoneRegistry } from './timezone.js';
import {
  wallFrameOf, toInstant, parseDuration, localKey, DAY_MS,
  wallFrameMillis, partsOf,
} from './datetime.js';

/**
 * 解析并展开一份（或多份拼接的）ICS 文本。
 * @param {string} text ICS 原文
 * @param {{rangeStart:string, rangeEnd:string, sourceName:string}} options
 *   rangeStart/rangeEnd 为 "YYYY-MM-DD"，rangeEnd 按不包含该日处理
 * @returns {ExpansionResult}
 */
export function expandICS(text, options = {}) {
  const warnings = [];
  const { calendars, warnings: parseWarnings } = parseICS(text);
  warnings.push(...parseWarnings);

  const registry = new TimezoneRegistry();
  registry.registerFromCalendars(calendars);

  // 收集全部 VEVENT（可能来自多个 VCALENDAR，例如重新订阅的增量文件）
  const rawEvents = [];
  for (const ci of calendars.keys()) {
    const cal = calendars[ci];
    const method = textProp(cal, 'METHOD');
    for (const node of cal.children.filter((c) => c.name === 'VEVENT')) {
      rawEvents.push(buildRawEvent(node, method, ci, warnings));
    }
  }

  const groups = groupByUid(rawEvents, warnings);
  const range = buildRange(options, warnings);
  const instances = [];
  const unsupported = [];

  for (const group of groups.values()) {
    const result = expandGroup(group, registry, range, warnings);
    instances.push(...result.instances);
    unsupported.push(...result.unsupported);
  }
  warnings.push(...registry.warnings);

  instances.sort((a, b) => a.startEpoch - b.startEpoch || a.uid.localeCompare(b.uid));

  return {
    instances,
    warnings: dedupe(warnings),
    unsupported: dedupe(unsupported),
    groups: summarizeGroups(groups),
    range,
  };
}

function buildRawEvent(node, method, calendarIndex, warnings) {
  const uid = textProp(node, 'UID') || `__anon_${node.lines[0]}_${Math.random().toString(36).slice(2)}`;
  const dtstartLine = prop(node, 'DTSTART');
  if (!dtstartLine) {
    warnings.push(`UID=${uid} 的 VEVENT 缺少 DTSTART，已跳过`);
    return null;
  }
  let dtstart;
  try {
    dtstart = parseDateTime(dtstartLine.value, dtstartLine.params);
  } catch (err) {
    warnings.push(`UID=${uid} 的 DTSTART 解析失败: ${err.message}`);
    return null;
  }
  const isAllDay = dtstart.kind === 'date';

  // 结束时间：DTEND 优先，其次 DURATION，否则按全天 1 天 / 定时 0 时长
  let durationSec = 0;
  const dtendLine = prop(node, 'DTEND');
  if (dtendLine) {
    let dtend;
    try {
      dtend = parseDateTime(dtendLine.value, dtendLine.params);
    } catch (err) {
      warnings.push(`UID=${uid} 的 DTEND 解析失败: ${err.message}`);
      dtend = null;
    }
    if (dtend) {
      if (isAllDay) {
        // 全天事件：DTEND 是排他边界，保留日期分量差
        const s = dtstart.date.split('-').map(Number);
        const e = dtend.date.split('-').map(Number);
        durationSec = Math.round(
          (wallFrameMillis(e[0], e[1], e[2]) - wallFrameMillis(s[0], s[1], s[2])) / 1000
        );
        if (durationSec <= 0) {
          warnings.push(`UID=${uid} 的全天事件 DTEND 不晚于 DTSTART，按 1 天处理`);
          durationSec = 86400;
        }
      } else {
        // 定时事件取钟面时间差；同一事件的 DTSTART/DTEND 时区不同属病态输入，
        // 真实时刻换算在 makeInstance 阶段按各自 TZID 处理
        durationSec = Math.round((wallFrameOf(dtend) - wallFrameOf(dtstart)) / 1000);
        if (durationSec <= 0) {
          warnings.push(`UID=${uid} 的 DTEND 不晚于 DTSTART，时长按 0 处理`);
        }
      }
    }
  } else {
    const durLine = prop(node, 'DURATION');
    if (durLine) {
      try {
        durationSec = parseDuration(durLine.value);
      } catch (err) {
        warnings.push(`UID=${uid} 的 DURATION 解析失败: ${err.message}`);
      }
    } else if (isAllDay) {
      durationSec = 86400; // RFC 4791 惯例：无 DTEND 的 VALUE=DATE 事件持续 1 天
    }
  }

  const rruleLine = prop(node, 'RRULE');
  let rrule = null;
  if (rruleLine) {
    rrule = parseRRule(rruleLine.value);
    if (rrule.unsupported.length) {
      warnings.push(`UID=${uid} 存在暂不支持的重复规则: ${rrule.unsupported.join('；')}`);
    }
  }

  const exdates = [];
  for (const line of props(node, 'EXDATE')) {
    for (const v of line.value.split(',')) {
      try {
        exdates.push({ dt: parseDateTime(v.trim(), line.params), raw: line.raw });
      } catch (err) {
        warnings.push(`UID=${uid} 的 EXDATE 项 “${v}” 解析失败: ${err.message}`);
      }
    }
  }
  const rdates = [];
  for (const line of props(node, 'RDATE')) {
    for (const v of line.value.split(',')) {
      try {
        rdates.push({ dt: parseDateTime(v.trim(), line.params), raw: line.raw });
      } catch (err) {
        warnings.push(`UID=${uid} 的 RDATE 项 “${v}” 解析失败: ${err.message}`);
      }
    }
  }

  const recIdLine = prop(node, 'RECURRENCE-ID');
  let recurrenceId = null;
  if (recIdLine) {
    try {
      recurrenceId = parseDateTime(recIdLine.value, recIdLine.params);
    } catch (err) {
      warnings.push(`UID=${uid} 的 RECURRENCE-ID 解析失败: ${err.message}`);
    }
  }

  return {
    uid,
    summary: textProp(node, 'SUMMARY') || '(无标题)',
    description: textProp(node, 'DESCRIPTION') || '',
    location: textProp(node, 'LOCATION') || '',
    status: (textProp(node, 'STATUS') || '').toUpperCase(),
    method: method || null,
    sequence: prop(node, 'SEQUENCE') ? Number(prop(node, 'SEQUENCE').value) : 0,
    dtstamp: textProp(node, 'DTSTAMP') || '',
    lastModified: textProp(node, 'LAST-MODIFIED') || '',
    dtstart,
    durationSec,
    isAllDay,
    rrule,
    exdates,
    rdates,
    recurrenceId,
    rawLines: node.lines,
    calendarIndex,
  };
}

/**
 * 按 UID 分组并挑选版本。
 * 主事件（无 RECURRENCE-ID）：SEQUENCE 高者胜，平手时 DTSTAMP/LAST-MODIFIED 新者胜；
 * 例外事件（有 RECURRENCE-ID）：同一 RECURRENCE-ID 同样按版本规则挑选。
 */
function groupByUid(rawEvents, warnings) {
  const groups = new Map();
  for (const ev of rawEvents.filter(Boolean)) {
    if (!groups.has(ev.uid)) groups.set(ev.uid, { uid: ev.uid, masters: [], overrides: new Map() });
    const g = groups.get(ev.uid);
    if (ev.recurrenceId) {
      const key = localKeyOf(ev.recurrenceId);
      const existing = g.overrides.get(key);
      if (!existing || compareVersion(ev, existing) > 0) g.overrides.set(key, ev);
    } else {
      g.masters.push(ev);
    }
  }
  for (const g of groups.values()) {
    g.masters.sort((a, b) => compareVersion(b, a));
    g.master = g.masters[0] || null;
    if (!g.master) {
      warnings.push(`UID=${g.uid} 只有例外记录、缺少主事件，例外记录将作为独立日程展示`);
    }
    if (g.masters.length > 1) {
      g.discardedMasters = g.masters.slice(1).map((m) => ({
        sequence: m.sequence, dtstamp: m.dtstamp, status: m.status, method: m.method,
      }));
    }
  }
  return groups;
}

/** 版本比较：>0 表示 a 更新 */
function compareVersion(a, b) {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const ts = (x) => x.lastModified || x.dtstamp || '';
  return ts(a).localeCompare(ts(b));
}

function expandGroup(group, registry, range, warnings) {
  const instances = [];
  const unsupported = [];
  const master = group.master;

  // 没有主事件：例外记录各自独立展示
  if (!master) {
    for (const ov of group.overrides.values()) {
      instances.push(makeInstance(ov, ov.dtstart, 'orphan-override', registry, group, warnings));
    }
    return { instances, unsupported };
  }

  // 整组取消（METHOD=CANCAL 或 STATUS=CANCELLED 的主事件）只影响这一组
  const groupCancelled = master.method === 'CANCEL' || master.status === 'CANCELLED';

  const startParts = dateParts(master.dtstart);
  const ruleUnsupported = master.rrule && master.rrule.unsupported.length > 0;
  if (ruleUnsupported) {
    unsupported.push({
      uid: master.uid,
      summary: master.summary,
      reasons: master.rrule.unsupported,
      raw: master.rrule.raw,
    });
  }

  // 排除/补充/例外的本地键集合
  const exKeys = new Set(master.exdates.map((x) => localKeyOf(x.dt)));
  const overrideKeys = new Set(group.overrides.keys());

  const pushCandidate = (dateParts3, timeParts, origin) => {
    const dt = synthesizeDt(master.dtstart, dateParts3, timeParts);
    const key = localKeyOf(dt);
    if (exKeys.has(key)) return;
    if (overrideKeys.has(key)) {
      const ov = group.overrides.get(key);
      if (ov.status === 'CANCELLED' || ov.method === 'CANCEL') return; // 单次取消，仅删这一次
      instances.push(makeInstance(ov, ov.dtstart, 'override', registry, group, warnings, master));
      return;
    }
    instances.push(makeInstance(master, dt, origin, registry, group, warnings));
  };

  if (master.rrule && !ruleUnsupported) {
    const spec = master.rrule;
    const timeParts = master.isAllDay ? null : {
      h: master.dtstart.hour, mi: master.dtstart.minute, s: master.dtstart.second,
    };
    let emitted = 0;
    const untilFrame = spec.until ? untilToFrame(spec.until, master, registry, warnings) : null;
    genLoop:
    for (const cand of dateGenerator(spec, startParts)) {
      const dt = synthesizeDt(master.dtstart, cand, timeParts);
      const frame = wallFrameOf(dt);
      if (untilFrame !== null && frame > untilFrame) break;
      if (spec.count !== null && emitted >= spec.count) break;
      emitted++; // COUNT 对所有规则实例计数，包括被 EXDATE/例外排除的那些
      if (frame < range.startFrame - 2 * DAY_MS || frame > range.endFrame + 2 * DAY_MS) continue;
      pushCandidate(cand, timeParts, 'rrule');
      if (emitted > 100_000) {
        warnings.push(`UID=${master.uid} 展开超过 10 万次已截断，请检查 RRULE`);
        break genLoop;
      }
    }
    if (spec.count !== null && emitted < spec.count) {
      warnings.push(`UID=${master.uid} 的 COUNT=${spec.count} 在查询范围/年限内只能展开 ${emitted} 次`);
    }
  } else if (!master.rrule) {
    // 单次事件
    pushCandidate(startParts, master.isAllDay ? null : {
      h: master.dtstart.hour, mi: master.dtstart.minute, s: master.dtstart.second,
    }, 'single');
  } else {
    // 不支持的规则：只展开 DTSTART 锚点，并明确标注，避免静默少展开
    pushCandidate(startParts, master.isAllDay ? null : {
      h: master.dtstart.hour, mi: master.dtstart.minute, s: master.dtstart.second,
    }, 'unsupported-anchor');
  }

  // RDATE 补充的额外日期
  for (const rdate of master.rdates) {
    const key = localKeyOf(rdate.dt);
    if (exKeys.has(key)) continue;
    if (overrideKeys.has(key)) continue; // 同日有例外记录，以例外为准
    if (instances.some((i) => i.localKey === key)) continue;
    instances.push(makeInstance(master, rdate.dt, 'rdate', registry, group, warnings));
  }

  // 范围过滤：[startFrame, endFrame) 半开区间，结束日排他。
  // 事件占用 [start, start+duration)，与查询区间有真实重叠才保留；
  // 在结束日当天 00:00 开始的事件（含全天事件）不落入区间。
  const filtered = instances.filter((ins) => {
    const eventEnd = ins.startFrame + ins.durationSec * 1000;
    return ins.startFrame < range.endFrame && eventEnd > range.startFrame;
  });

  if (groupCancelled) for (const ins of filtered) ins.cancelled = true;
  return { instances: filtered, unsupported };
}

/**
 * 由主事件的起始类型 + 候选日期分量合成具体一次的起始 dateTime
 */
function synthesizeDt(prototype, dp, timeParts) {
  if (prototype.kind === 'date') {
    return { kind: 'date', date: `${dp.y}-${pad(dp.mo)}-${pad(dp.d)}`, isAllDay: true };
  }
  const base = {
    date: `${dp.y}-${pad(dp.mo)}-${pad(dp.d)}`,
    hour: timeParts ? timeParts.h : prototype.hour,
    minute: timeParts ? timeParts.mi : prototype.minute,
    second: timeParts ? timeParts.s : prototype.second,
  };
  if (prototype.kind === 'utc') return { kind: 'utc', ...base };
  if (prototype.kind === 'zoned') return { kind: 'zoned', tzid: prototype.tzid, ...base };
  return { kind: 'floating', ...base };
}

function makeInstance(sourceEvent, dt, origin, registry, group, warnings, masterEvent = null) {
  const start = toInstant(dt, registry);
  if (start.kind === 'unknown-zone') {
    warnings.push(`UID=${sourceEvent.uid} 的一次日程使用了无法解析的时区 “${start.tzid}”，时刻按钟面展示`);
  }
  const durationSec = sourceEvent.durationSec;
  const endEpoch = start.epoch + durationSec * 1000;
  const p = partsOf(start.kind === 'zoned' || start.kind === 'utc'
    ? start.epoch + (start.offsetMinutes ?? 0) * 60000
    : start.epoch);
  return {
    id: `${sourceEvent.uid}::${localKeyOf(dt)}`,
    // 稳定场次标识：同一 UID 在同一当地日期的那一次，跨重新订阅保持不变，
    // 即使主事件改了钟点（09:00→09:30）也能被识别为同一场次的「变更」而非取消+新增。
    // 例外记录锚定它所替换的原始场次日期（RECURRENCE-ID），改期后仍视为同一场次。
    occurrenceKey: sourceEvent.recurrenceId
      ? `${sourceEvent.uid}::${sourceEvent.recurrenceId.date}`
      : `${sourceEvent.uid}::${dt.date}`,
    uid: sourceEvent.uid,
    localKey: localKeyOf(dt),
    summary: sourceEvent.summary,
    description: sourceEvent.description,
    location: sourceEvent.location,
    status: sourceEvent.status,
    cancelled: sourceEvent.status === 'CANCELLED' || sourceEvent.method === 'CANCEL',
    origin, // single | rrule | rdate | override | orphan-override | unsupported-anchor
    startEpoch: start.epoch,
    endEpoch,
    durationSec,
    startFrame: wallFrameOf(dt),
    offsetMinutes: start.offsetMinutes,
    timeKind: start.kind,
    tzid: dt.kind === 'zoned' ? dt.tzid : null,
    isAllDay: sourceEvent.isAllDay,
    wallDate: `${p.y}-${pad(p.mo)}-${pad(p.d)}`,
    wallTime: sourceEvent.isAllDay ? null : `${pad(p.h)}:${pad(p.mi)}`,
    sourceLines: sourceEvent.rawLines,
    sourceSequence: sourceEvent.sequence,
    sourceDtstamp: sourceEvent.dtstamp,
    masterUid: masterEvent ? masterEvent.uid : sourceEvent.uid,
    recurrenceId: sourceEvent.recurrenceId ? localKeyOf(sourceEvent.recurrenceId) : null,
    groupDiscarded: group.discardedMasters || [],
  };
}

function buildRange(options, warnings) {
  const today = new Date();
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const startStr = options.rangeStart || iso(new Date(today.getTime() - 31 * DAY_MS));
  const endStr = options.rangeEnd || iso(new Date(today.getTime() + 120 * DAY_MS));
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) {
      warnings.push(`日期范围 “${s}” 格式应为 YYYY-MM-DD，已回退默认范围`);
      return null;
    }
    // 起止都取当天 00:00 框架；结束日的排他性由半开区间过滤保证
    return wallFrameMillis(Number(m[1]), Number(m[2]), Number(m[3]));
  };
  let startFrame = parse(startStr);
  let endFrame = parse(endStr);
  if (startFrame === null) startFrame = wallFrameOf({ kind: 'date', date: iso(new Date(today.getTime() - 31 * DAY_MS)) });
  if (endFrame === null) endFrame = wallFrameOf({ kind: 'date', date: iso(new Date(today.getTime() + 120 * DAY_MS)) });
  // 同一日历日作为起止时是空区间（结束日排他）；倒挂范围同样不自动交换
  if (endFrame <= startFrame) {
    warnings.push('展开范围结束日不晚于开始日，该范围不包含任何日程');
    endFrame = startFrame;
  }
  return { startStr, endStr, startFrame, endFrame };
}

function summarizeGroups(groups) {
  const out = [];
  for (const g of groups.values()) {
    out.push({
      uid: g.uid,
      summary: g.master ? g.master.summary : '(仅例外记录)',
      sequence: g.master ? g.master.sequence : null,
      status: g.master ? g.master.status : null,
      overrideCount: g.overrides.size,
      discardedMasters: g.discardedMasters || [],
    });
  }
  return out;
}

function dateParts(dt) {
  const [y, mo, d] = dt.date.split('-').map(Number);
  return { y, mo, d };
}

function localKeyOf(dt) {
  if (dt.kind === 'date') return dt.date.replace(/-/g, '');
  return localKey(
    ...dt.date.split('-').map(Number),
    dt.hour, dt.minute, dt.second
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function untilToFrame(until, master, registry, warnings) {
  try {
    const dt = parseDateTime(until, {});
    if (dt.kind === 'utc') return wallFrameOf(dt);
    // 非 UTC 的 UNTIL（RFC 5545 要求 UTC，但容忍真实世界文件）：
    // 日期型与全天/浮动锚点直接按钟面比较；带时区的按主事件时区解释
    if (dt.kind === 'date') return wallFrameOf(dt) + DAY_MS - 1;
    if (dt.kind === 'floating') return wallFrameOf(dt);
    const inst = toInstant(dt, registry);
    if (inst.kind === 'unknown-zone') {
      warnings.push(`UID=${master.uid} 的 UNTIL 时区 “${dt.tzid}” 无法解析，按钟面比较`);
      return wallFrameOf(dt);
    }
    return inst.epoch + inst.offsetMinutes * 60000;
  } catch {
    warnings.push(`UID=${master.uid} 的 UNTIL “${until}” 解析失败，该规则可能无法正确终止`);
    return null;
  }
}

function dedupe(arr) {
  return [...new Set(arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))]
    .map((x) => (x.startsWith('{') ? JSON.parse(x) : x));
}

export { unescapeText, addDays };
