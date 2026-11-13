import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandICS } from '../src/engine.js';

const RANGE = { rangeStart: '2026-11-01', rangeEnd: '2026-12-31' };

function ics(events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//ZH', ...events, 'END:VCALENDAR'].join('\n');
}

test('跨多天的全天事件：DTEND 排他，时长为完整天数', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:multi@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:三天全天',
    'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261113',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const ins = r.instances.find((i) => i.uid === 'multi@x');
  assert.equal(ins.durationSec, 3 * 86400);
  assert.equal(ins.isAllDay, true);
  assert.equal(ins.wallDate, '2026-11-10');
});

test('UTC 定时事件按 Z 时间展开并标注 UTC', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:utc@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:UTC 会议',
    'DTSTART:20261105T130000Z', 'DTEND:20261105T140000Z',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const ins = r.instances.find((i) => i.uid === 'utc@x');
  assert.equal(ins.timeKind, 'utc');
  assert.equal(ins.offsetMinutes, 0);
  assert.equal(new Date(ins.startEpoch).toISOString(), '2026-11-05T13:00:00.000Z');
});

test('DURATION 替代 DTEND 时正确计算时长', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:dur@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:90 分钟',
    'DTSTART;TZID=America/New_York:20261105T090000', 'DURATION:PT1H30M',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const ins = r.instances.find((i) => i.uid === 'dur@x');
  assert.equal(ins.durationSec, 5400);
});

test('每日重复 INTERVAL=2 且带 COUNT', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:ev2@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:隔天',
    'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102',
    'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const dates = r.instances.filter((i) => i.uid === 'ev2@x').map((i) => i.wallDate);
  assert.deepEqual(dates, ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07']);
});

test('EXDATE 只排除指定那一次，其余照常', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:ex@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:每日但跳过 3 号',
    'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102',
    'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;VALUE=DATE:20261103',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const dates = r.instances.filter((i) => i.uid === 'ex@x').map((i) => i.wallDate);
  assert.deepEqual(dates, ['2026-11-01', '2026-11-02', '2026-11-04', '2026-11-05']);
});

test('RDATE 补充的日期即使不在 RRULE 节奏上也会出现', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:rd@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:周会加开一场',
    'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261103',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2',
    'RDATE;VALUE=DATE:20261106',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const dates = r.instances.filter((i) => i.uid === 'rd@x').map((i) => i.wallDate).sort();
  assert.ok(dates.includes('2026-11-06'));
  assert.ok(dates.includes('2026-11-02'));
  assert.ok(dates.includes('2026-11-09'));
});

test('UNTIL 终止：边界当天的实例保留，之后不再生成', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:until@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:到 5 号为止',
    'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102',
    'RRULE:FREQ=DAILY;UNTIL=20261105',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const dates = r.instances.filter((i) => i.uid === 'until@x').map((i) => i.wallDate);
  assert.deepEqual(dates, ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
});

test('例外记录改时间后，原场次消失且新场次标注 override', () => {
  const text = ics([
    'BEGIN:VEVENT', 'UID:ov@x', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:0',
    'SUMMARY:例会',
    'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261103',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:ov@x', 'DTSTAMP:20260103T000000Z', 'SEQUENCE:1',
    'RECURRENCE-ID;VALUE=DATE:20261109',
    'SUMMARY:例会改期',
    'DTSTART;VALUE=DATE:20261111', 'DTEND;VALUE=DATE:20261112',
    'END:VEVENT',
  ]);
  const r = expandICS(text, RANGE);
  const list = r.instances.filter((i) => i.uid === 'ov@x');
  assert.ok(!list.some((i) => i.wallDate === '2026-11-09'));
  const moved = list.find((i) => i.wallDate === '2026-11-11');
  assert.equal(moved.origin, 'override');
  assert.equal(moved.summary, '例会改期');
});

test('带时区的 DURATION 事件跨夏令时回拨仍保持当地钟点', () => {
  const tz = [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400',
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const text = ics([
    ...tz,
    'BEGIN:VEVENT', 'UID:dst@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:跨 DST 周会',
    'DTSTART;TZID=America/New_York:20261030T090000',
    'DTEND;TZID=America/New_York:20261030T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=2',
    'END:VEVENT',
  ]);
  const r = expandICS(text, { rangeStart: '2026-10-01', rangeEnd: '2026-12-31' });
  const [a, b] = r.instances.filter((i) => i.uid === 'dst@x').sort((x, y) => x.startEpoch - y.startEpoch);
  assert.equal(a.wallTime, '09:00');
  assert.equal(b.wallTime, '09:00'); // 11/6 已回拨，钟点仍是 09:00
  assert.equal(a.offsetMinutes, -240);
  assert.equal(b.offsetMinutes, -300);
  // UTC 时刻相差 1 小时（钟点漂移）
  assert.equal((b.startEpoch - a.startEpoch) / 3600000, 7 * 24 + 1);
});
