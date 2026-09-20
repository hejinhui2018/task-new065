import type { ScheduledItem } from './player'

/**
 * 内置的“网络抖动 + 批次复核”演练场景。
 *
 * 直播阶段（逻辑时间固定，可稳定重放）：
 *   +0.0s  #101 新字幕
 *   +1.5s  #103 新字幕（#102 尚未到达，时间线出现缺口）
 *   +3.0s  #103 重复推送（同一事件 ID，应被去重）
 *   +4.5s  #102 晚到（应自动补回缺口）
 *  +10.0s  #102 的机器修订 v2（若已锁定则转入人工裁决）
 *
 * 直播结束后的批次补发：
 *  +12.0s  批次 postlive-1：#102 v3 改写、#104 新增、
 *           #103 v2（锁定时为冲突条目）、#101 v1 同内容（无变化）
 *  +15.0s  同一批次 ID 重复补发（必须判重，不能重复应用）
 *  +17.0s  复核期间 #101 v3 又走单事件通道到达（批次应标记过期并重算）
 *
 * 修订故意留足间隔，方便运营暂停、编辑、锁定，或在批次面板里逐条勾选。
 */
export const SCENARIO_TITLE = '网络抖动 + 批次复核：乱序 · 重复 · 晚到 · 锁定 · 补发批次'

export const SCENARIO: ScheduledItem[] = [
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
  {
    at: 12000,
    batchId: 'postlive-1',
    label: '赛后补发批次 A',
    events: [
      { id: 'evt-b-102-v3', seq: 102, version: 3, kind: 'revision', text: '现在是北京时间晚上八点零六分。' },
      { id: 'evt-b-104-v1', seq: 104, version: 1, kind: 'create', text: '以上是本次直播的全部内容，感谢收看。' },
      { id: 'evt-b-103-v2', seq: 103, version: 2, kind: 'revision', text: '首先来关注今天的主要新闻摘要。' },
      { id: 'evt-b-101-v1-dup', seq: 101, version: 1, kind: 'create', text: '各位观众晚上好，欢迎收看晚间新闻直播。' },
    ],
  },
  {
    at: 15000,
    batchId: 'postlive-1',
    label: '赛后补发批次 A',
    events: [
      { id: 'evt-b-102-v3', seq: 102, version: 3, kind: 'revision', text: '现在是北京时间晚上八点零六分。' },
      { id: 'evt-b-104-v1', seq: 104, version: 1, kind: 'create', text: '以上是本次直播的全部内容，感谢收看。' },
      { id: 'evt-b-103-v2', seq: 103, version: 2, kind: 'revision', text: '首先来关注今天的主要新闻摘要。' },
      { id: 'evt-b-101-v1-dup', seq: 101, version: 1, kind: 'create', text: '各位观众晚上好，欢迎收看晚间新闻直播。' },
    ],
  },
  {
    at: 17000,
    event: {
      id: 'evt-101-v3-late',
      seq: 101,
      version: 3,
      kind: 'revision',
      text: '各位观众晚上好，欢迎收看今晚八点的新闻直播。',
    },
  },
]

export const SCENARIO_HINT =
  '直播阶段：#101 → #103 → #103（重复）→ #102（晚到）→ #102 修订 v2。' +
  '直播结束后 +12s 到达补发批次（新增/改写/冲突/无变化），+15s 同一批次重复补发会被判重，' +
  '+17s 复核期间又有更新，批次将标记过期并重新计算。' +
  '提示：可在批次到达前暂停并锁定 #103，观察它在批次中默认被排除；在面板里解锁后才能勾选接受。'
