/**
 * 领域模型：字幕事件、字幕片段、冲突、事件日志。
 *
 * 所有时间均为“逻辑时间”（相对场景开始的毫秒数），由事件/动作携带，
 * 状态层本身从不读取时钟，保证可稳定重放。
 */

/** 机器侧推送的事件类型：新字幕 / 修订 */
export type EventKind = 'create' | 'revision'

/** 机器推送的一条字幕事件 */
export interface SubtitleEvent {
  /** 事件唯一 ID，用于去重（网络重发时 ID 不变） */
  id: string
  /** 字幕序号，时间线按它排序 */
  seq: number
  /** 内容版本号，单调递增 */
  version: number
  kind: EventKind
  text: string
}

/** 批次内单条变更相对当前时间线的分类 */
export type BatchChangeKind =
  | 'added' // 新增：该序号尚无片段
  | 'revised' // 改写：版本更新、内容不同
  | 'conflict' // 冲突：片段已锁定，机器修订被拦截
  | 'unchanged' // 无变化：同版本同内容（重复补发）
  | 'stale' // 过期：版本不高于当前（同版本内容矛盾也归此）

/** 批次中的一条候选变更（由批次原始事件与当前时间线计算，绝不静默落库） */
export interface BatchItem {
  seq: number
  /** 携带该变更的机器事件 ID（用于复核期间去重判断） */
  eventId: string
  incomingVersion: number
  incomingText: string
  kind: BatchChangeKind
  /** 锁定片段默认排除；用户明确解锁（解锁冲突条目）后才能进入批次 */
  locked: boolean
  /** 当前时间线内容快照（新增时为 null），供界面对照 */
  currentText: string | null
  currentVersion: number | null
  /** 运营勾选：是否随“接受”应用；锁定/过期/无变化条目不可勾选 */
  selected: boolean
}

/** 场景脚本中的一条：在 at 毫秒时投递 event */
export interface ScheduledEvent {
  at: number
  event: SubtitleEvent
}

/** 场景脚本中的一次批次补发：在 at 毫秒时把 events 整批交给复核台 */
export interface ScheduledBatch {
  at: number
  /** 稳定批次 ID；重发时 ID 不变，用于“补发重复到达”去重 */
  batchId: string
  label: string
  events: SubtitleEvent[]
}

export type SegmentOrigin = 'machine' | 'manual'

/** 时间线上的一条字幕片段 */
export interface SubtitleSegment {
  seq: number
  text: string
  version: number
  /** 当前内容的来源：机器推送 or 人工修改 */
  origin: SegmentOrigin
  /** 锁定后机器修订不再静默覆盖，转入人工裁决 */
  locked: boolean
}

/** 一条待裁决冲突：锁定片段收到了更新的机器版本 */
export interface Conflict {
  seq: number
  /** 冲突发生瞬间的人工内容快照（用于日志与兜底展示） */
  manualText: string
  manualVersion: number
  incomingText: string
  incomingVersion: number
  receivedAt: number | null
}

export type LogKind =
  | 'received' // 正常接收新片段
  | 'backfilled' // 晚到片段补回缺口
  | 'duplicate' // 重复事件/重复内容，已忽略
  | 'stale' // 过期或矛盾的版本，已忽略
  | 'revised' // 机器修订已直接应用
  | 'conflict' // 锁定片段收到修订，转入人工裁决
  | 'manual' // 人工修改
  | 'lock' // 锁定 / 解锁
  | 'resolved' // 冲突已裁决
  | 'batch' // 批次复核：开启 / 接受 / 关闭 / 过期重算
  | 'history' // 撤销 / 重做

export interface LogEntry {
  id: number
  kind: LogKind
  seq: number | null
  /** 逻辑时间；人工操作为 null（界面显示“手动”） */
  at: number | null
  message: string
}

/** 进行中的批次复核会话（一次补发对应一个稳定 ID 的会话） */
export interface ReviewBatch {
  /** 稳定批次 ID，来自补发数据；重复补发同一 ID 不会重复应用 */
  id: string
  label: string
  /** 批次到达的逻辑时间 */
  openedAt: number | null
  /** 批次原始事件，按 seq 去重后保留每 seq 最高版本；重算完全由它驱动 */
  events: SubtitleEvent[]
  /** 相对当前时间线计算出的候选条目 */
  items: BatchItem[]
  /** 批次打开后时间线是否又发生变化（机器补发/晚到），旧选择不可静默套用 */
  stale: boolean
  /** 累计已应用的事件 ID，防止同批或重发重复应用 */
  appliedEventIds: string[]
}

/** 撤销/重做所需的快照（状态本身纯数据，可直接整体保存） */
export interface HistoryEntry {
  state: ConsoleState
  label: string
}

/** 控制台全部状态。纯数据、可深比较，reset 后必须与初始状态完全一致。 */
export interface ConsoleState {
  segments: Record<number, SubtitleSegment>
  /** 已见过的事件 ID 集合，用于事件级去重 */
  seenEventIds: Record<string, true>
  conflicts: Conflict[]
  log: LogEntry[]
  nextLogId: number
  /** 进行中的批次复核；没有批次或批次已关闭时为 null */
  activeBatch: ReviewBatch | null
  /** 已结束批次的稳定 ID，重复补发时直接判重 */
  closedBatchIds: string[]
  /** 撤销栈（最近的在末尾）；不保存批次打开动作 */
  past: HistoryEntry[]
  /** 重做栈 */
  future: HistoryEntry[]
}
