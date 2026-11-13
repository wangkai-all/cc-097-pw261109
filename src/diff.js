// 重新订阅（再次导入同一日历）后的差异比较：
// 以「UID + 本地 RECURRENCE-ID 键」标识每一次日程，对比新旧两次展开结果，
// 输出 added（新增）/ changed（变更）/ cancelled（取消或消失）三类。
// 上一次的结果完整保留，页面可并排查看。

/**
 * @param {object[]} oldInstances 上一次展开的实例
 * @param {object[]} newInstances 本次展开的实例
 * @returns {{added:object[], changed:object[], cancelled:object[], unchanged:object[]}}
 */
export function diffInstances(oldInstances, newInstances) {
  // 用稳定场次标识（UID + 当地日期，例外记录锚定 RECURRENCE-ID 日期）配对，
  // 这样仅改钟点/时长不会被误判为「取消+新增」，而是同一场次的变更。
  const oldMap = new Map(oldInstances.map((i) => [i.occurrenceKey || i.id, i]));
  const newMap = new Map(newInstances.map((i) => [i.occurrenceKey || i.id, i]));
  const added = [];
  const changed = [];
  const cancelled = [];
  const unchanged = [];

  for (const [key, ni] of newMap) {
    const oi = oldMap.get(key);
    if (!oi) {
      added.push(ni);
      continue;
    }
    const fields = changedFields(oi, ni);
    if (ni.cancelled && !oi.cancelled) {
      cancelled.push({ instance: ni, fields: ['cancelled'] });
    } else if (fields.length) {
      changed.push({ instance: ni, old: oi, fields });
    } else {
      unchanged.push(ni);
    }
  }
  for (const [key, oi] of oldMap) {
    if (!newMap.has(key)) {
      cancelled.push({ instance: oi, fields: ['removed'] });
    }
  }
  const sortFn = (a, b) =>
    (a.instance ? a.instance.startEpoch : a.startEpoch) -
    (b.instance ? b.instance.startEpoch : b.startEpoch);
  added.sort((a, b) => a.startEpoch - b.startEpoch);
  changed.sort(sortFn);
  cancelled.sort(sortFn);
  return { added, changed, cancelled, unchanged };
}

function changedFields(a, b) {
  const checks = [
    ['startEpoch', '开始时间'],
    ['endEpoch', '结束时间'],
    ['summary', '标题'],
    ['location', '地点'],
    ['description', '描述'],
    ['status', '状态'],
    ['offsetMinutes', '时区偏移'],
  ];
  const fields = [];
  for (const [key, label] of checks) {
    if (a[key] !== b[key]) fields.push(label);
  }
  return fields;
}

/**
 * 汇总订阅级变化（主事件维度），用于顶部摘要卡片。
 */
export function diffSummary(groupsBefore, groupsAfter) {
  const before = new Map((groupsBefore || []).map((g) => [g.uid, g]));
  const after = new Map((groupsAfter || []).map((g) => [g.uid, g]));
  const added = [], removed = [], modified = [];
  for (const [uid, g] of after) {
    const old = before.get(uid);
    if (!old) added.push(g);
    else if (old.sequence !== g.sequence || old.status !== g.status ||
             old.overrideCount !== g.overrideCount) modified.push({ before: old, after: g });
  }
  for (const [uid, g] of before) {
    if (!after.has(uid)) removed.push(g);
  }
  return { added, removed, modified };
}
