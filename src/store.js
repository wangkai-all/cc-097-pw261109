// 订阅状态持久化：保留每次导入的原始 ICS 文本与展开结果，
// 以便重新订阅时比较新增/变更/取消。调整展开范围不会改写这里保存的原始日历。

const STORE_KEY = 'ics-expander-subscriptions-v1';

function safeStorage() {
  try {
    const probe = '__ics_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null; // 隐私模式等场景下降级为内存存储
  }
}

const memoryStore = new Map();

export class SubscriptionStore {
  constructor() {
    this.storage = safeStorage();
  }

  load() {
    try {
      const raw = this.storage
        ? this.storage.getItem(STORE_KEY)
        : memoryStore.get(STORE_KEY);
      return raw ? JSON.parse(raw) : { subscriptions: [] };
    } catch {
      return { subscriptions: [] };
    }
  }

  save(state) {
    const raw = JSON.stringify(state);
    if (this.storage) this.storage.setItem(STORE_KEY, raw);
    else memoryStore.set(STORE_KEY, raw);
  }

  /**
   * 保存一次订阅快照。
   * @param {string} name 订阅名（同一名称视为重新订阅）
   * @param {string} icsText 原始 ICS 文本（永不被展开范围改写）
   * @param {object} result expandICS 的结果（实例裁剪可序列化字段）
   */
  upsert(name, icsText, result, options) {
    const state = this.load();
    const snapshot = {
      name,
      icsText,
      importedAt: new Date().toISOString(),
      options: { rangeStart: options.rangeStart, rangeEnd: options.rangeEnd },
      result: serializeResult(result),
    };
    const idx = state.subscriptions.findIndex((s) => s.name === name);
    let previous = null;
    if (idx >= 0) {
      previous = state.subscriptions[idx];
      state.subscriptions[idx] = { ...snapshot, history: [
        { importedAt: previous.importedAt, result: previous.result, options: previous.options },
        ...(previous.history || []),
      ].slice(0, 5) };
    } else {
      state.subscriptions.push(snapshot);
    }
    this.save(state);
    return { state, previous };
  }

  remove(name) {
    const state = this.load();
    state.subscriptions = state.subscriptions.filter((s) => s.name !== name);
    this.save(state);
    return state;
  }
}

function serializeResult(result) {
  return {
    instances: result.instances.map((i) => ({ ...i, sourceLines: [...i.sourceLines] })),
    warnings: result.warnings,
    unsupported: result.unsupported,
    groups: result.groups,
    range: result.range,
  };
}
