import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expandICS } from '../src/engine.js';
import { diffInstances } from '../src/diff.js';
import { parseRRule, dateGenerator } from '../src/rrule.js';
import { parseICS, unfoldLines, parseContentLine, parseDateTime } from '../src/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', 'samples');
const readSample = (n) => readFile(join(samples, n), 'utf8');

const RANGE = { rangeStart: '2026-10-01', rangeEnd: '2027-01-31' };

test('行展开与内容行解析', () => {
  const text = 'BEGIN:VCALENDAR\r\nSUMMARY:hello\r\n world\r\nDTSTART;TZID=America/New_York:20260310T090000\r\n';
  const lines = unfoldLines(text);
  // RFC 5545：折行的引导空白被删除，两行直接拼接
  assert.ok(lines.includes('SUMMARY:helloworld'));  const cl = parseContentLine('DTSTART;TZID=America/New_York:20260310T090000');
  assert.equal(cl.name, 'DTSTART');
  assert.equal(cl.params.TZID, 'America/New_York');
  assert.equal(cl.value, '20260310T090000');
});

test('parseDateTime 区分 UTC / 带时区 / 浮动 / 全天', () => {
  assert.equal(parseDateTime('20261102').kind, 'date');
  assert.equal(parseDateTime('20261102T090000Z').kind, 'utc');
  assert.equal(parseDateTime('20261102T090000', { TZID: 'X' }).kind, 'zoned');
  assert.equal(parseDateTime('20261102T090000', {}).kind, 'floating');
});

test('解析器能识别多日历与嵌套组件', () => {
  const { calendars } = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0].children[0].name, 'VEVENT');
});

test('RRULE: 每日 COUNT', () => {
  const spec = parseRRule('FREQ=DAILY;COUNT=3');
  const out = [...dateGenerator(spec, { y: 2026, mo: 11, d: 2 })].slice(0, 3);
  assert.deepEqual(out.map((d) => d.d), [2, 3, 4]);
});

test('RRULE: 每周多日 + INTERVAL', () => {
  const spec = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2;WKST=MO');
  const out = [...dateGenerator(spec, { y: 2026, mo: 11, d: 2 })].slice(0, 4);
  // 2026-11-02 是周一；第一周 2/4/6，跳一周后 16/18/20
  assert.deepEqual(out.map((d) => `${d.y}-${d.mo}-${d.d}`),
    ['2026-11-2', '2026-11-4', '2026-11-6', '2026-11-16']);
});

test('RRULE: 每月月末（BYMONTHDAY=-1）自动收敛', () => {
  const spec = parseRRule('FREQ=MONTHLY;BYMONTHDAY=-1');
  const out = [...dateGenerator(spec, { y: 2026, mo: 10, d: 31 })].slice(0, 3);
  assert.deepEqual(out.map((d) => `${d.mo}-${d.d}`), ['10-31', '11-30', '12-31']);
});

test('RRULE: 每月第 2 个周一与最后一个周一', () => {
  const spec2 = parseRRule('FREQ=MONTHLY;BYDAY=2MO');
  const second = dateGenerator(spec2, { y: 2026, mo: 11, d: 1 }).next().value;
  assert.equal(second.d, 9); // 2026-11 第二个周一是 9 号
  const specLast = parseRRule('FREQ=MONTHLY;BYDAY=-1MO');
  const last = dateGenerator(specLast, { y: 2026, mo: 11, d: 1 }).next().value;
  assert.equal(last.d, 30);
});

test('RRULE: 每年感恩节（11 月第四个周四）', () => {
  const spec = parseRRule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH');
  const out = dateGenerator(spec, { y: 2026, mo: 1, d: 1 }).next().value;
  assert.equal(out.d, 26); // 2026 感恩节 11/26
});

test('RRULE: 未支持部分明确上报', () => {
  const spec = parseRRule('FREQ=HOURLY;INTERVAL=2;COUNT=8');
  assert.ok(spec.unsupported.some((u) => u.includes('HOURLY')));
  const spec2 = parseRRule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1');
  assert.ok(spec2.unsupported.some((u) => u.includes('BYSETPOS')));
});

test('样本一：月末全天事件展开且 DTEND 排他', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const { instances } = expandICS(ics, RANGE);
  const closes = instances.filter((i) => i.uid === 'monthly-finance-close@sample');
  assert.ok(closes.length >= 3);
  assert.deepEqual(closes.slice(0, 3).map((i) => i.wallDate),
    ['2026-10-31', '2026-11-30', '2026-12-31']);
  for (const c of closes) {
    assert.equal(c.isAllDay, true);
    assert.equal(c.durationSec, 86400); // 排他 DTEND → 恰好 1 天
  }
});

test('样本一：夏令时切换保持当地钟点 09:00', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const { instances } = expandICS(ics, RANGE);
  const meetings = instances
    .filter((i) => i.uid === 'weekly-ny-standup@sample' && i.origin === 'rrule')
    .sort((a, b) => a.startEpoch - b.startEpoch);
  assert.ok(meetings.length >= 8);
  // 11/1 之前是 EDT(-04:00)，11/1 当周起是 EST(-05:00)，钟面始终 09:00
  for (const m of meetings) {
    assert.equal(m.wallTime, '09:00');
    assert.equal(m.tzid, 'America/New_York');
  }
  const before = meetings.find((m) => m.wallDate === '2026-10-23');
  const after = meetings.find((m) => m.wallDate === '2026-11-06');
  assert.equal(before.offsetMinutes, -240);
  assert.equal(after.offsetMinutes, -300);
  // UTC 时刻相差恰好 1 小时钟点漂移：09:00 EDT = 13:00Z，09:00 EST = 14:00Z
  assert.equal(new Date(before.startEpoch).toISOString(), '2026-10-23T13:00:00.000Z');
  assert.equal(new Date(after.startEpoch).toISOString(), '2026-11-06T14:00:00.000Z');
});

test('样本一：EXDATE 排除 + RDATE 补回', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const { instances } = expandICS(ics, RANGE);
  const standups = instances.filter((i) => i.uid === 'weekly-ny-standup@sample');
  assert.ok(!standups.some((i) => i.wallDate === '2026-11-27' && i.wallTime === '09:00'));
  const rdate = standups.find((i) => i.wallDate === '2026-11-28');
  assert.ok(rdate);
  assert.equal(rdate.origin, 'rdate');
  assert.equal(rdate.wallTime, '10:00');
});

test('样本一：单次改期的例外记录只改一次', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const { instances } = expandICS(ics, RANGE);
  const syncs = instances.filter((i) => i.uid === 'team-sync@sample');
  // 11/16（周一）不应存在；11/18（周三）存在例外
  assert.ok(!syncs.some((i) => i.wallDate === '2026-11-16'));
  const moved = syncs.find((i) => i.wallDate === '2026-11-18');
  assert.ok(moved);
  assert.equal(moved.origin, 'override');
  assert.match(moved.summary, /改到周三/);
  // 其它周一保持原标题
  const normal = syncs.find((i) => i.wallDate === '2026-11-23');
  assert.equal(normal.summary, '团队周会');
});

test('样本一：单次取消不影响整组', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const { instances } = expandICS(ics, RANGE);
  const syncs = instances.filter((i) => i.uid === 'team-sync@sample');
  assert.ok(!syncs.some((i) => i.wallDate === '2026-11-09')); // 那一次被取消
  assert.ok(syncs.length >= 6); // 其它场次仍在
  assert.ok(!syncs.every((i) => i.cancelled));
});

test('样本一：浮动时间不做时区换算', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const { instances } = expandICS(ics, RANGE);
  const fl = instances.find((i) => i.uid === 'floating-deadline@sample');
  assert.equal(fl.timeKind, 'floating');
  assert.equal(fl.offsetMinutes, null);
  assert.equal(fl.wallTime, '18:00');
});

test('整组取消（STATUS=CANCELLED）标记每一次但不删除', async () => {
  const ics = await readSample('sample-2-resubscribe-v2.ics');
  const { instances } = expandICS(ics, RANGE);
  const syncs = instances.filter((i) => i.uid === 'team-sync@sample');
  assert.ok(syncs.length > 0);
  assert.ok(syncs.every((i) => i.cancelled === true));
});

test('重新订阅：新增 / 变更 / 取消分类正确', async () => {
  const v1 = await readSample('sample-1-recurrence.ics');
  const v2 = await readSample('sample-2-resubscribe-v2.ics');
  const r1 = expandICS(v1, RANGE);
  const r2 = expandICS(v2, RANGE);
  const diff = diffInstances(r1.instances, r2.instances);
  // 新增：季度复盘
  assert.ok(diff.added.some((i) => i.uid === 'quarterly-review@sample'));
  // 变更：站会 09:00 → 09:30，同一场次（稳定 occurrenceKey）应识别为变更而非取消+新增
  const standupChange = diff.changed.filter((c) => c.instance.uid === 'weekly-ny-standup@sample');
  assert.ok(standupChange.length > 0, '站会场次应出现在变更列表');
  assert.ok(standupChange.every((c) => c.fields.includes('开始时间') || c.fields.includes('结束时间')));
  // 站会不应再被算作新增/消失（同一当地日期的场次配对成功）
  assert.ok(!diff.added.some((i) => i.uid === 'weekly-ny-standup@sample'));
  assert.ok(!diff.cancelled.some((c) => c.fields.includes('removed') && c.instance.uid === 'weekly-ny-standup@sample'));
  // 取消：team-sync 整组（STATUS=CANCELLED，实例仍保留但带取消标记）
  assert.ok(diff.cancelled.some((c) => c.instance.uid === 'team-sync@sample'
    && c.fields.includes('cancelled')));
});

test('样本三：未支持规则明确列出且只展开锚点', async () => {
  const ics = await readSample('sample-3-unsupported.ics');
  const result = expandICS(ics, RANGE);
  assert.ok(result.unsupported.some((u) => u.uid === 'last-workday-run@sample'));
  assert.ok(result.unsupported.some((u) => u.uid === 'hourly-poll@sample'));
  const anchor = result.instances.filter((i) => i.uid === 'hourly-poll@sample');
  assert.equal(anchor.length, 1);
  assert.equal(anchor[0].origin, 'unsupported-anchor');
  // 对照组正常展开 5 次
  const daily = result.instances.filter((i) => i.uid === 'normal-daily@sample');
  assert.equal(daily.length, 5);
});

test('范围调整只改变查询结果：缩小范围后实例变少，原始数据不变', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  const wide = expandICS(ics, { rangeStart: '2026-10-01', rangeEnd: '2027-01-31' });
  const narrow = expandICS(ics, { rangeStart: '2026-11-01', rangeEnd: '2026-12-01' });
  assert.ok(narrow.instances.length < wide.instances.length);
  // 原始行仍完整保留在实例来源信息中
  assert.ok(wide.instances[0].sourceLines.some((l) => l.startsWith('UID:')));
});

test('范围结束日按不包含该日处理', async () => {
  const ics = await readSample('sample-1-recurrence.ics');
  // 开始日即结束日：空区间，任何事件都不落入
  const r = expandICS(ics, { rangeStart: '2026-10-31', rangeEnd: '2026-10-31' });
  assert.equal(r.instances.length, 0);
  // 结束日当天开始的事件不包含在内
  const r2 = expandICS(ics, { rangeStart: '2026-10-01', rangeEnd: '2026-10-31' });
  assert.ok(!r2.instances.some((i) => i.wallDate === '2026-10-31'));
  const r3 = expandICS(ics, { rangeStart: '2026-10-30', rangeEnd: '2026-11-01' });
  assert.ok(r3.instances.some((i) => i.wallDate === '2026-10-30'));
  assert.ok(r3.instances.some((i) => i.wallDate === '2026-10-31'));
});

test('同 UID 按 SEQUENCE 选取版本，旧版本被记录', async () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:v@x', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:0',
    'SUMMARY:旧版', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:v@x', 'DTSTAMP:20260102T000000Z', 'SEQUENCE:3',
    'SUMMARY:新版', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\n');
  const r = expandICS(ics, RANGE);
  const ins = r.instances.filter((i) => i.uid === 'v@x');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].summary, '新版');
  assert.equal(r.groups.find((g) => g.uid === 'v@x').discardedMasters.length, 1);
});

test('METHOD=CANCEL 的整组取消不删除其它 UID 的日程', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'METHOD:CANCEL',
    'BEGIN:VEVENT', 'UID:cancel-me@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:取消组', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106',
    'END:VEVENT', 'END:VCALENDAR',
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:keep-me@x', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:保留组', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\n');
  const r = expandICS(ics, RANGE);
  const cancelled = r.instances.find((i) => i.uid === 'cancel-me@x');
  const kept = r.instances.find((i) => i.uid === 'keep-me@x');
  assert.equal(cancelled.cancelled, true);
  assert.equal(kept.cancelled, false);
});
