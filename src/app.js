// 前端应用：上传/样本加载 → 展开 → 日历与明细表渲染 → 来源抽屉 → 重新订阅对比。
// 所有解析与展开逻辑复用 src/ 下的纯模块，本文件只负责交互与渲染。

import { expandICS } from './engine.js';
import { diffInstances } from './diff.js';
import { SubscriptionStore } from './store.js';
import { formatOffset } from './datetime.js';

const SAMPLES = [
  { file: 'samples/sample-1-recurrence.ics', name: '示例一·月末/夏令时/单次改期', desc: '月末重复、DST 切换保持钟点、EXDATE/RDATE、单次改期与取消' },
  { file: 'samples/sample-2-resubscribe-v2.ics', name: '示例二·重新订阅更新版', desc: '同名再次导入：新增季度复盘、站会改时间、整组取消' },
  { file: 'samples/sample-3-unsupported.ics', name: '示例三·未支持规则', desc: 'BYSETPOS 与 HOURLY 明确告警，对照事件正常展开' },
];

const ORIGIN_LABEL = {
  single: '单次',
  rrule: '重复规则',
  rdate: '额外日期 RDATE',
  override: '例外改期',
  'orphan-override': '孤立例外',
  'unsupported-anchor': '未支持规则锚点',
};

const state = {
  subscriptionName: '',
  current: null,        // 本次 expandICS 结果
  currentIcs: '',
  previousSnapshot: null,
  diff: null,
  view: 'calendar',
  calYear: 0,
  calMonth: 0,          // 1-12
  diffFilter: 'all',
  showingHistory: false,
  displayResult: null,  // 当前实际渲染的结果（历史对比时可指向 previous）
};

const store = new SubscriptionStore();
const $ = (id) => document.getElementById(id);

// ---------- 初始化 ----------
init();

function init() {
  const today = new Date();
  state.calYear = today.getFullYear();
  state.calMonth = today.getMonth() + 1;
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('range-start').value = iso(new Date(today.getTime() - 31 * 86400000));
  $('range-end').value = iso(new Date(today.getTime() + 120 * 86400000));

  bindEvents();
  renderSampleCards();
  refreshSubscriptionSelect();
}

function bindEvents() {
  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  });

  const dropZone = $('drop-zone');
  ['dragover', 'dragenter'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });

  $('btn-apply-range').addEventListener('click', () => {
    if (!state.current) { toast('请先导入日历文件'); return; }
    // 范围调整只重新查询，不触碰保存的原始 ICS
    runExpansion(state.currentIcs, state.subscriptionName, { persist: false });
  });

  $('tab-calendar').addEventListener('click', () => switchView('calendar'));
  $('tab-table').addEventListener('click', () => switchView('table'));
  $('cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('cal-next').addEventListener('click', () => shiftMonth(1));
  $('cal-today').addEventListener('click', () => {
    const t = new Date();
    state.calYear = t.getFullYear();
    state.calMonth = t.getMonth() + 1;
    renderCalendar();
  });

  $('btn-samples').addEventListener('click', () => {
    document.querySelector('.empty-state').classList.remove('hidden');
    document.querySelector('.empty-state').scrollIntoView({ behavior: 'smooth' });
  });

  $('subscription-select').addEventListener('change', (e) => loadSubscription(e.target.value));
  $('btn-delete-sub').addEventListener('click', deleteCurrentSubscription);

  $('diff-filter').addEventListener('change', (e) => {
    state.diffFilter = e.target.value;
    renderTable();
  });
  $('btn-dismiss-diff').addEventListener('click', () => $('diff-banner').classList.add('hidden'));
  $('btn-toggle-history').addEventListener('click', toggleHistory);

  $('drawer-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

function renderSampleCards() {
  const host = $('sample-list');
  host.innerHTML = '';
  for (const s of SAMPLES) {
    const card = document.createElement('button');
    card.className = 'sample-card';
    card.type = 'button';
    card.innerHTML = `<b>${s.name}</b><span>${s.desc}</span>`;
    card.addEventListener('click', () => loadSample(s));
    host.appendChild(card);
  }
}

// ---------- 数据导入 ----------
async function loadSample(sample) {
  try {
    const resp = await fetch(sample.file);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!$('sub-name').value) $('sub-name').value = sample.name;
    await ingest(text, sample.name);
  } catch (err) {
    toast(`样本加载失败: ${err.message}`);
  }
}

async function handleFile(file) {
  const text = await file.text();
  const name = $('sub-name').value || file.name.replace(/\.ics$/i, '');
  $('sub-name').value = name;
  await ingest(text, name);
}

async function ingest(icsText, name) {
  state.subscriptionName = name;
  state.currentIcs = icsText;
  state.showingHistory = false;
  runExpansion(icsText, name, { persist: true });
}

function rangeOptions() {
  return {
    rangeStart: $('range-start').value,
    rangeEnd: $('range-end').value,
    sourceName: state.subscriptionName,
  };
}

function runExpansion(icsText, name, { persist }) {
  let result;
  try {
    result = expandICS(icsText, rangeOptions());
  } catch (err) {
    toast(`展开失败: ${err.message}`);
    return;
  }
  state.current = result;
  state.displayResult = result;

  let previous = null;
  if (persist) {
    const saved = store.upsert(name, icsText, result, rangeOptions());
    previous = saved.previous;
    refreshSubscriptionSelect();
  } else {
    // 仅调整范围：仍取已保存的上一版用于对比
    const snap = store.load().subscriptions.find((s) => s.name === name);
    previous = snap?.history?.[0] ? { result: snap.history[0].result } : null;
  }

  state.previousSnapshot = previous;
  if (previous && previous.result) {
    state.diff = diffInstances(previous.result.instances, result.instances);
    showDiffBanner();
  } else {
    state.diff = null;
    $('diff-banner').classList.add('hidden');
  }

  renderWarnings(result);
  renderAll();
  if (persist) toast(persist && previous ? '重新订阅完成，已生成新增/变更/取消对比' : `导入成功，展开 ${result.instances.length} 次日程`);
}

// ---------- 订阅管理 ----------
function refreshSubscriptionSelect() {
  const data = store.load();
  const sel = $('subscription-select');
  const keep = sel.value;
  sel.innerHTML = '<option value="">— 已保存订阅 —</option>';
  for (const s of data.subscriptions) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.name}（${new Date(s.importedAt).toLocaleString('zh-CN')}）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function loadSubscription(name) {
  if (!name) return;
  const snap = store.load().subscriptions.find((s) => s.name === name);
  if (!snap) return;
  state.subscriptionName = snap.name;
  state.currentIcs = snap.icsText;
  $('sub-name').value = snap.name;
  $('range-start').value = snap.options.rangeStart;
  $('range-end').value = snap.options.rangeEnd;
  state.current = snap.result;
  state.displayResult = snap.result;
  state.previousSnapshot = snap.history?.[0] ? { result: snap.history[0].result } : null;
  state.diff = state.previousSnapshot
    ? diffInstances(state.previousSnapshot.result.instances, snap.result.instances)
    : null;
  state.showingHistory = false;
  $('btn-toggle-history').textContent = '查看上次结果';
  if (state.diff) showDiffBanner(); else $('diff-banner').classList.add('hidden');
  renderWarnings(snap.result);
  renderAll();
  toast(`已载入订阅「${name}」`);
}

function deleteCurrentSubscription() {
  const name = $('subscription-select').value || state.subscriptionName;
  if (!name) { toast('请先选择要删除的订阅'); return; }
  if (!confirm(`确认删除订阅「${name}」及其历史快照？`)) return;
  store.remove(name);
  refreshSubscriptionSelect();
  toast('订阅已删除');
}

function toggleHistory() {
  if (!state.previousSnapshot) { toast('没有上次结果可比较'); return; }
  state.showingHistory = !state.showingHistory;
  state.displayResult = state.showingHistory ? state.previousSnapshot.result : state.current;
  $('btn-toggle-history').textContent = state.showingHistory ? '返回本次结果' : '查看上次结果';
  renderAll();
  toast(state.showingHistory ? '正在展示上次展开结果（只读）' : '已返回本次结果');
}

// ---------- 对比横幅 ----------
function showDiffBanner() {
  const d = state.diff;
  $('diff-banner').classList.remove('hidden');
  $('diff-added-count').textContent = d.added.length;
  $('diff-changed-count').textContent = d.changed.length;
  $('diff-cancelled-count').textContent = d.cancelled.length;
  $('diff-unchanged-count').textContent = d.unchanged.length;
}

function diffCategoryOf(instance) {
  if (!state.diff) return null;
  const key = instance.occurrenceKey || instance.id;
  if (state.diff.added.some((i) => (i.occurrenceKey || i.id) === key)) return 'added';
  if (state.diff.changed.some((c) => (c.instance.occurrenceKey || c.instance.id) === key)) return 'changed';
  if (state.diff.cancelled.some((c) => (c.instance.occurrenceKey || c.instance.id) === key)) return 'cancelled';
  return 'unchanged';
}

// ---------- 告警面板 ----------
function renderWarnings(result) {
  const panel = $('warnings-panel');
  const list = $('warnings-list');
  list.innerHTML = '';
  const unsupportedUids = new Set(result.unsupported.map((u) => u.uid));
  let count = 0;
  for (const u of result.unsupported) {
    count++;
    const div = document.createElement('div');
    div.className = 'warning-item unsupported';
    div.innerHTML = `<b>未支持规则 · ${escapeHtml(u.summary)}</b> <code>${escapeHtml(u.uid)}</code><br>
      原因：${u.reasons.map(escapeHtml).join('；')}<br>
      规则原文：<code>${escapeHtml(u.raw)}</code><br>
      处理：仅展示 DTSTART 锚点日程，不会静默少展开。`;
    list.appendChild(div);
  }
  for (const w of result.warnings) {
    if (unsupportedUids.size && [...unsupportedUids].some((uid) => w.includes(uid))) continue;
    count++;
    const div = document.createElement('div');
    div.className = 'warning-item';
    div.textContent = w;
    list.appendChild(div);
  }
  $('warning-count').textContent = count;
  panel.classList.toggle('hidden', count === 0);
}

// ---------- 视图切换与渲染 ----------
function switchView(view) {
  state.view = view;
  $('tab-calendar').classList.toggle('active', view === 'calendar');
  $('tab-table').classList.toggle('active', view === 'table');
  renderAll();
}

function shiftMonth(delta) {
  let m = state.calMonth + delta;
  let y = state.calYear;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  state.calMonth = m;
  state.calYear = y;
  renderCalendar();
}

function renderAll() {
  // 已导入但范围内无日程时仍展示空的日历/表格，不回退到初始引导态
  $('empty-state').classList.toggle('hidden', !!state.current);
  if (!state.current) return;
  if (state.view === 'calendar') {
    $('calendar-view').classList.remove('hidden');
    $('table-view').classList.add('hidden');
    renderCalendar();
  } else {
    $('table-view').classList.remove('hidden');
    $('calendar-view').classList.add('hidden');
    renderTable();
  }
}

function renderCalendar() {
  const grid = $('calendar-grid');
  grid.innerHTML = '';
  $('cal-title').textContent = `${state.calYear} 年 ${state.calMonth} 月` +
    (state.showingHistory ? '（上次结果）' : '');

  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  for (const w of weekdays) {
    const h = document.createElement('div');
    h.className = 'cal-weekday';
    h.textContent = `周${w}`;
    grid.appendChild(h);
  }

  const first = new Date(Date.UTC(state.calYear, state.calMonth - 1, 1));
  const startWeekday = (first.getUTCDay() + 6) % 7; // 周一为 0
  const gridStart = new Date(first.getTime() - startWeekday * 86400000);
  const todayIso = new Date().toISOString().slice(0, 10);

  const byDate = groupByDate(state.displayResult.instances);

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (d.getUTCMonth() !== state.calMonth - 1) cell.classList.add('outside');
    if (iso === todayIso) cell.classList.add('today');

    const dateLabel = document.createElement('div');
    dateLabel.className = 'cal-date';
    dateLabel.textContent = d.getUTCDate();
    cell.appendChild(dateLabel);

    const eventsHost = document.createElement('div');
    eventsHost.className = 'cal-events';
    const dayEvents = (byDate.get(iso) || []).slice().sort((a, b) => a.startEpoch - b.startEpoch);
    const MAX = 3;
    dayEvents.slice(0, MAX).forEach((ins) => eventsHost.appendChild(buildPill(ins)));
    if (dayEvents.length > MAX) {
      const more = document.createElement('span');
      more.className = 'event-more';
      more.textContent = `还有 ${dayEvents.length - MAX} 项…`;
      eventsHost.appendChild(more);
    }
    cell.appendChild(eventsHost);
    grid.appendChild(cell);
  }
}

function buildPill(ins) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `event-pill ${ins.isAllDay ? 'allday' : 'timed'} ${ins.origin} ${ins.cancelled ? 'cancelled' : ''}`;
  const cat = diffCategoryOf(ins);
  if (cat && cat !== 'unchanged') btn.classList.add(`diff-${cat}`);
  const time = ins.isAllDay ? '全天' : ins.wallTime;
  btn.textContent = `${time} ${ins.summary}`;
  btn.title = `${ORIGIN_LABEL[ins.origin] || ins.origin} · ${ins.uid}`;
  btn.addEventListener('click', () => openDrawer(ins));
  return btn;
}

function groupByDate(instances) {
  const map = new Map();
  for (const ins of instances) {
    if (!map.has(ins.wallDate)) map.set(ins.wallDate, []);
    map.get(ins.wallDate).push(ins);
  }
  return map;
}

function renderTable() {
  const body = $('table-view').querySelector('#table-body');
  body.innerHTML = '';
  const all = state.displayResult.instances;
  const rows = all.filter((ins) => {
    if (!state.diff || state.diffFilter === 'all') return true;
    return diffCategoryOf(ins) === state.diffFilter;
  });
  $('table-count').textContent =
    `共 ${all.length} 次日程` +
    (state.diffFilter !== 'all' ? `，当前筛选 ${rows.length} 次` : '') +
    (state.showingHistory ? '（上次结果）' : '');

  for (const ins of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row-clickable';
    const cat = diffCategoryOf(ins);
    if (cat && cat !== 'unchanged') tr.classList.add(`diff-${cat}`);
    if (ins.cancelled) tr.classList.add('cancelled-row');

    const statusHtml = ins.cancelled
      ? '<span class="status-tag cancel">已取消</span>'
      : '<span class="status-tag ok">正常</span>';
    const timeCell = ins.isAllDay
      ? '全天'
      : `${ins.wallTime}${ins.durationSec ? `（${formatDuration(ins.durationSec)}）` : ''}`;
    const tzCell = formatTimeKind(ins);
    tr.innerHTML = `
      <td>${statusHtml}</td>
      <td>${ins.wallDate}</td>
      <td>${timeCell}</td>
      <td class="cell-title">${escapeHtml(ins.summary)}</td>
      <td><span class="origin-tag ${ins.origin}">${ORIGIN_LABEL[ins.origin] || ins.origin}</span></td>
      <td>${escapeHtml(tzCell)}</td>
      <td class="uid-cell" title="${escapeHtml(ins.uid)}">${escapeHtml(ins.uid)}</td>`;
    tr.addEventListener('click', () => openDrawer(ins));
    body.appendChild(tr);
  }
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}小时${m}分`;
  if (h) return `${h}小时`;
  return `${m}分钟`;
}

function formatTimeKind(ins) {
  if (ins.isAllDay) return '全天（结束日排他）';
  if (ins.timeKind === 'floating') return '浮动时间（无时区）';
  if (ins.timeKind === 'utc') return 'UTC';
  if (ins.timeKind === 'unknown-zone') return `未知时区 ${ins.tzid}`;
  return `${ins.tzid}（${formatOffset(ins.offsetMinutes)}）`;
}

// ---------- 来源抽屉 ----------
function openDrawer(ins) {
  const body = $('drawer-body');
  const cat = diffCategoryOf(ins);
  const diffNote = cat && cat !== 'unchanged'
    ? `<div class="warning-item ${cat === 'cancelled' ? 'unsupported' : ''}">
         本次订阅对比：<b>${({ added: '新增日程', changed: '发生变更', cancelled: '取消/消失' })[cat]}</b>
       </div>` : '';
  const changeFields = state.diff?.changed.find(
    (c) => (c.instance.occurrenceKey || c.instance.id) === (ins.occurrenceKey || ins.id)
  )?.fields;
  const changeNote = changeFields?.length
    ? `<div class="warning-item">变更字段：${changeFields.map(escapeHtml).join('、')}</div>` : '';

  body.innerHTML = `
    ${diffNote}${changeNote}
    <div class="detail-section">
      <h3>展开后的这一次</h3>
      <dl class="kv">
        <dt>标题</dt><dd>${escapeHtml(ins.summary)}</dd>
        <dt>当地日期</dt><dd>${ins.wallDate}</dd>
        <dt>当地时间</dt><dd>${ins.isAllDay ? '全天（DTEND 排他）' : ins.wallTime}</dd>
        <dt>时间类型</dt><dd>${escapeHtml(formatTimeKind(ins))}</dd>
        <dt>时长</dt><dd>${formatDuration(ins.durationSec)}</dd>
        <dt>来源类型</dt><dd>${ORIGIN_LABEL[ins.origin] || ins.origin}</dd>
        <dt>状态</dt><dd>${ins.cancelled ? '已取消' : (ins.status || '正常')}</dd>
        <dt>实例标识</dt><dd><code>${escapeHtml(ins.localKey)}</code></dd>
      </dl>
    </div>
    <div class="detail-section">
      <h3>来自哪条原始记录</h3>
      <dl class="kv">
        <dt>UID</dt><dd><code>${escapeHtml(ins.uid)}</code></dd>
        <dt>SEQUENCE</dt><dd>${ins.sourceSequence}</dd>
        <dt>DTSTAMP</dt><dd>${escapeHtml(ins.sourceDtstamp || '—')}</dd>
        ${ins.recurrenceId ? `<dt>RECURRENCE-ID</dt><dd><code>${escapeHtml(ins.recurrenceId)}</code>（例外记录）</dd>` : ''}
        ${ins.location ? `<dt>地点</dt><dd>${escapeHtml(ins.location)}</dd>` : ''}
        ${ins.description ? `<dt>描述</dt><dd>${escapeHtml(ins.description)}</dd>` : ''}
      </dl>
    </div>
    <div class="detail-section">
      <h3>原始 VEVENT 内容（${ins.sourceLines.length} 行）</h3>
      <pre class="raw-lines">${ins.sourceLines.map((l) => highlightLine(escapeHtml(l))).join('\n')}</pre>
    </div>`;
  $('detail-drawer').classList.remove('hidden');
  $('detail-drawer').setAttribute('aria-hidden', 'false');
}

function highlightLine(line) {
  if (/^(UID|RECURRENCE-ID|RRULE|EXDATE|RDATE|SEQUENCE|STATUS|DTSTART|DTEND)/.test(line)) {
    return `<span class="hl">${line}</span>`;
  }
  return line;
}

function closeDrawer() {
  $('detail-drawer').classList.add('hidden');
  $('detail-drawer').setAttribute('aria-hidden', 'true');
}

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}
