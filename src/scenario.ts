import type { ScheduledEvent } from './types'

/**
 * 内置的“网络抖动 + 直播后补发”演练场景。
 *
 * 直播段（逻辑时间固定，可稳定重放）：
 *   +0.0s   #101 新字幕
 *   +1.5s   #103 新字幕（#102 尚未到达，时间线出现缺口）
 *   +3.0s   #103 重复推送（同一事件 ID，应被去重）
 *   +4.5s   #102 晚到（应自动补回缺口）
 *  +10.0s   #102 的机器修订 v2（若已锁定则转入人工裁决）
 *
 * 直播结束后的补发批次 batch-post-live（+13.0s 一次补发多条）：
 *   #104 新增、#101 v2 改写、#103 v1 同内容（无变化）、
 *   #104 重发（批次内重复，不得重复应用）、#102 v3（锁定即冲突，默认排除）
 *  +16.0s   批次复核进行中，常规直播流 #106 仍直接落位
 *  +20.0s   同批次的 #105 晚到：批次必须标记过期并重新计算，不能静默套用旧选择
 */
export const SCENARIO_TITLE = '网络抖动演练：乱序 · 重复 · 晚到 · 修订 · 批次复核'

const POST_LIVE_BATCH = 'batch-post-live'

export const SCENARIO: ScheduledEvent[] = [
  {
    at: 0,
    event: { id: 'evt-101-v1', seq: 101, version: 1, kind: 'create', text: '各位观众晚上好，欢迎收看晚间新闻直播。' },
  },
  {
    at: 1500,
    event: { id: 'evt-103-v1', seq: 103, version: 1, kind: 'create', text: '首先来看今天的主要新闻摘要。' },
  },
  {
    at: 3000,
    event: { id: 'evt-103-v1', seq: 103, version: 1, kind: 'create', text: '首先来看今天的主要新闻摘要。' },
  },
  {
    at: 4500,
    event: { id: 'evt-102-v1', seq: 102, version: 1, kind: 'create', text: '现在是北京时间晚上八点整。' },
  },
  {
    at: 10000,
    event: { id: 'evt-102-v2', seq: 102, version: 2, kind: 'revision', text: '现在是北京时间晚上八点零五分。' },
  },

  // —— 直播结束后机器一次补发的修订批次 ——
  {
    at: 13000,
    batch: POST_LIVE_BATCH,
    event: { id: 'evt-104-v1', seq: 104, version: 1, kind: 'create', text: '以上是今天新闻的全部内容，感谢您的收看。' },
  },
  {
    at: 13000,
    batch: POST_LIVE_BATCH,
    event: { id: 'evt-101-v2', seq: 101, version: 2, kind: 'revision', text: '各位观众晚上好，欢迎收看晚间新闻直播完整版。' },
  },
  {
    at: 13000,
    batch: POST_LIVE_BATCH,
    // 与已落位的 #103 v1 完全一致：批次内应列为“无变化”
    event: { id: 'evt-103-v1-resend', seq: 103, version: 1, kind: 'revision', text: '首先来看今天的主要新闻摘要。' },
  },
  {
    at: 13000,
    batch: POST_LIVE_BATCH,
    // 同事件 ID 重发：批次内重复，去重后只能有一条 #104
    event: { id: 'evt-104-v1', seq: 104, version: 1, kind: 'create', text: '以上是今天新闻的全部内容，感谢您的收看。' },
  },
  {
    at: 13000,
    batch: POST_LIVE_BATCH,
    // #102 若在直播段被人工锁定，此项为“锁定冲突”，默认排除
    event: { id: 'evt-102-v3', seq: 102, version: 3, kind: 'revision', text: '现在是北京时间晚上八点零五分整，新闻联播到此结束。' },
  },

  // —— 复核进行中，批次外的常规流不受影响 ——
  {
    at: 16000,
    event: { id: 'evt-106-v1', seq: 106, version: 1, kind: 'create', text: '稍后为您带来深度复盘节目，敬请期待。' },
  },

  // —— 同批次片段晚到：复核中收到更新，批次过期重算 ——
  {
    at: 20000,
    batch: POST_LIVE_BATCH,
    event: { id: 'evt-105-v1', seq: 105, version: 1, kind: 'create', text: '明天同一时间，我们再见。' },
  },
]

export const SCENARIO_HINT =
  '场景：#101 → #103 → #103（重复）→ #102（晚到）→ #102 修订 v2；' +
  '直播结束后 +13s 一次补发 5 条组成复核批次（新增/改写/无变化/重复/锁定冲突），'
  + '+20s 同批次 #105 晚到，批次将过期重算。可先暂停、逐条排除或整批接受，并试用撤销/重做；刷新页面复核现场会保留。'
