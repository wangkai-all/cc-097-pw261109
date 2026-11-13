# ICS 日历展开工具

导入 ICS 日历文件，把「每周重复」这样的一行规则展开成**每一次真正发生的日程**，
并在日历视图与明细表之间切换；点击任意一次日程，可以查看它来自哪条原始 VEVENT 记录。

纯原生实现（HTML + ES Module + Node 内置模块），**零第三方依赖、零构建步骤**，
所有数据只保存在本机浏览器的 localStorage 中，不会上传到任何服务器。

## 启动

```bash
npm start          # 等价于 node server.js，默认 http://localhost:8080
npm test           # 运行全部 36 个单元/集成测试（node:test）
```

也可以直接用浏览器打开 `index.html`（通过 `file://` 时「载入样本日历」的 fetch
会被浏览器拦截，改用上传或通过 `npm start` 访问即可）。

## 功能清单

### 展开能力
- **重复规则 RRULE**：`FREQ=DAILY / WEEKLY / MONTHLY / YEARLY`，支持 `INTERVAL`、
  `COUNT`、`UNTIL`、`BYDAY`（含 `2MO`、`-1FR` 序号）、`BYMONTHDAY`（含负数月末，
  自动按当月天数收敛）、`BYMONTH`、多日 `BYDAY`、`WKST`。
- **额外日期 RDATE / 排除日期 EXDATE**：补充与剔除指定场次。
- **例外记录 VEVENT + RECURRENCE-ID**：只改动某一次日程（改期、改标题）；
  `STATUS=CANCELLED` 的例外只取消那一次，不会误删整组。
- **版本选择**：相同 UID 按 `SEQUENCE` 选取主版本，平手时比较 `DTSTAMP` /
  `LAST-MODIFIED`，被淘汰的旧版本会记录在来源信息中。
- **整组取消**：主事件 `STATUS=CANCELLED` 或 `METHOD=CANCEL` 只把该 UID 的场次
  标记为已取消（保留可见、加删除线），不影响其它 UID。
- **时区与夏令时**：
  - 优先使用文件内嵌的 `VTIMEZONE`，按 RFC 5545 处理春季跳针（不存在的钟面采用
    跳变后偏移）与秋季回拨（重叠小时取先经过的旧偏移）；
  - 内嵌定义缺失时回退到运行环境的 `Intl` IANA 时区；
  - 两者都不可用时给出明确告警，绝不静默按 UTC 处理；
  - 带时区的重复日程始终保持当地约定钟点，UTC 时刻随夏令时漂移。
- **全天日程**：`DTEND` 按「不包含该日」的排他边界处理，`DTSTART;VALUE=DATE`
  无 `DTEND` 时按 1 天计。
- **浮动时间**：无 `TZID` 也无 `Z` 的时间按钟面原样展示，不做时区换算。
- **未支持规则明确上报**：`HOURLY/MINUTELY/SECONDLY`、`BYSETPOS`、`BYYEARDAY`、
  `BYWEEKNO`、`BYHOUR/BYMINUTE/BYSECOND`、`RSCALE/SKIP` 等会列入页面告警面板，
  对应事件只展示 DTSTART 锚点场次并标注 `unsupported-anchor`，不会悄悄少展开。

### 页面交互
- 上传 `.ics`（按钮或拖拽），设置展开起止日期（**结束日不含**）。
- 「日历视图 / 明细表」切换；日历按颜色区分全天、定时、RDATE、例外、取消、
  未支持锚点，并高亮重新订阅后的新增/变更/取消。
- 点击任意日程，右侧抽屉展示：展开后的当地时间、时间类型、来源类型、UID、
  SEQUENCE、RECURRENCE-ID，以及该次日程对应的**原始 VEVENT 全文**。
- **重新订阅**：用相同订阅名称再次导入，自动对比上一次结果，给出
  新增 / 变更 / 取消-消失 / 未变 四类统计与筛选，并可一键查看上次结果。
  对比使用稳定场次标识（UID + 当地日期，例外锚定 RECURRENCE-ID 日期），
  因此只改钟点（09:00→09:30）会被识别为「变更」而不是「取消 + 新增」。
- **调整展开范围只重新查询，不改写已保存的原始 ICS**；原始文本与历次快照
  完整保留在订阅存储中。

## 样本日历（`samples/`）

| 文件 | 覆盖场景 |
| --- | --- |
| `sample-1-recurrence.ics` | 月末重复（`BYMONTHDAY=-1`）、纽约时区跨夏令时保持 09:00 钟点、EXDATE 排除 + RDATE 补回、单次改期例外、单次取消例外、浮动时间 |
| `sample-2-resubscribe-v2.ics` | 同名重新订阅：新增季度复盘、站会改时间（SEQUENCE 升级）、整组 STATUS=CANCELLED |
| `sample-3-unsupported.ics` | BYSETPOS、HOURLY 等未支持规则的明确告警，对照组事件正常展开 |

## 代码结构

```
src/
  parser.js    RFC 5545 词法：折行还原、参数解析、组件树、DATE/DATE-TIME 解析
  datetime.js  钟面分量/UTC 框架、DURATION、偏移与时刻换算
  timezone.js  VTIMEZONE 引擎（跳针/重叠规则）+ Intl 回退
  rrule.js     RRULE 解析与惰性日期生成器（日/周/月/年）
  engine.js    VEVENT 分组、版本选择、EXDATE/RDATE/例外合并、范围过滤
  diff.js      重新订阅的场次级差异比较
  store.js     localStorage 订阅与历史快照持久化
  app.js       页面交互与渲染
test/          node:test 测试（36 个用例）
samples/       三份本地 ICS 样本
server.js      零依赖静态服务器
```

## 范围与边界说明

- 查询范围为半开区间 `[rangeStart, rangeEnd)`：结束日当天 00:00 开始的事件
  （含全天事件）不包含在结果内。
- RRULE 生成设有 10 万次安全上限，病态规则会截断并告警。
- `COUNT` 对所有规则实例计数（含被 EXDATE/例外排除的场次），符合 RFC 5545 语义。
- 浏览器 localStorage 有容量上限（通常 5MB 左右）；超大日历建议分次导入。
