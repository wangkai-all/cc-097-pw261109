import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS } from '../src/parser.js';
import { TimezoneRegistry } from '../src/timezone.js';
import { wallFrameMillis } from '../src/datetime.js';

// 构造一个含春跳针（2:00→3:00）与秋重叠（2:00→1:00）的 VTIMEZONE
const TZ_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTIMEZONE', 'TZID:Test/Zone',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:TDT',
  'DTSTART:20260308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:TST',
  'DTSTART:20261101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE', 'END:VCALENDAR',
].join('\n');

function resolver() {
  const { calendars } = parseICS(TZ_ICS);
  const reg = new TimezoneRegistry();
  reg.registerFromCalendars(calendars);
  return reg.get('Test/Zone');
}

test('冬令时常规钟点取 -05:00，夏令时取 -04:00', () => {
  const z = resolver();
  // 2026-02-01 09:00 处于 STANDARD
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 2, 1, 9, 0, 0)), -300);
  // 2026-07-01 09:00 处于 DAYLIGHT
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 7, 1, 9, 0, 0)), -240);
});

test('春季跳针：不存在的 02:30 采用跳变后偏移 -04:00', () => {
  const z = resolver();
  // 2026-03-08 02:30 在跳针间隙 [02:00,03:00)
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 3, 8, 2, 30, 0)), -240);
  // 01:59 仍是旧偏移 -05:00
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 3, 8, 1, 59, 0)), -300);
  // 03:00 起是新偏移
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 3, 8, 3, 0, 0)), -240);
});

test('秋季重叠：回拨的一小时取先经过的旧偏移 -04:00', () => {
  const z = resolver();
  // 2026-11-01 01:30 处于重叠区间 [01:00,02:00)，第一次经过时是夏令时 -04:00
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 11, 1, 1, 30, 0)), -240);
  // 00:59 仍是夏令时
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 11, 1, 0, 59, 0)), -240);
  // 02:00 起进入冬令时 -05:00
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 11, 1, 2, 0, 0)), -300);
});

test('内嵌 VTIMEZONE 缺失时回退 Intl（若环境支持）', () => {
  const reg = new TimezoneRegistry();
  const z = reg.get('America/New_York');
  if (!z) return; // 环境不支持该 IANA 名时跳过
  assert.equal(z.source, 'intl');
  // 2026-07 纽约为 EDT
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 7, 1, 12, 0, 0)), -240);
  // 2026-01 纽约为 EST
  assert.equal(z.offsetForWall(wallFrameMillis(2026, 1, 1, 12, 0, 0)), -300);
});

test('无法解析的时区返回 null 并登记告警，绝不静默按 UTC', () => {
  const reg = new TimezoneRegistry();
  const z = reg.get('Mars/Olympus_Mons');
  assert.equal(z, null);
  assert.ok(reg.warnings.some((w) => w.includes('Mars/Olympus_Mons')));
});
