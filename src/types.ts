/**
 * 领域模型：字幕事件、字幕片段、冲突、事件日志、批次复核。
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
  /** 所属补发批次 ID：携带后该事件进入对应批次缓冲，缺失时按常规直播流直接套用 */
  batchId?: string
}

/** 场景脚本中的一条：在 at 毫秒时投递 event */
export interface ScheduledEvent {
  at: number
  event: SubtitleEvent
  /**
   * 非空时表示该事件属于一次“补发批次”：播放器会在同组首条事件前
   * 投递 batch-begin、末条之后投递 batch-end。同字符串即同一批次，
   * 重复排程同组 begin 会被幂等忽略。
   */
  batch?: string
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

/** 批次内一个片段的最新机器版本（去重后只保留每个 seq 版本最高的一条） */
export interface BatchEntry {
  seq: number
  text: string
  version: number
  /** 产生该版本的事件 ID 集合（重发时追加，用于重复到达审计） */
  eventIds: string[]
  /** 该条目所有副本的最晚到达时间，用于展示 */
  receivedAt: number | null
}

/** 批次条目与当前时间线对比得出的分类 */
export type BatchItemKind = 'new' | 'rewrite' | 'conflict' | 'noop'

/** 批次状态：open 正在收集中；pending 已收齐等待复核；applied 已整批复核完毕 */
export type BatchPhase = 'open' | 'pending' | 'applied'

/**
 * 一次补发批次。复核过程中若同批次又有事件到达，staleSince 会被置位，
 * 条目重新计算，运营必须基于新内容重新选择，旧勾选不会被静默套用。
 */
export interface ReviewBatch {
  id: string
  phase: BatchPhase
  /** 批次内事件，按 seq 归并、保留最高版本 */
  entries: Record<number, BatchEntry>
  /** 待复核（pending）期间运营勾选要接受的 seq；锁定片段不在其中 */
  selected: number[]
  /** 进入待复核的逻辑时间 */
  openedAt: number | null
  /** 待复核期间又收到更新的逻辑时间；非 null 表示批次已过期、已重算 */
  staleSince: number | null
  /** 过期重算累计次数，用于展示与测试 */
  staleCount: number
  /** 历次“接受所选”已应用的 seq（支持部分接受时累计） */
  accepted: number[]
  /** 已接受并入时间线的条目数量（applied 后为最终值） */
  appliedCount: number
  /** 被排除（未接受）条目数量，applied 后用于审计展示 */
  excludedCount: number
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
  | 'batch' // 批次复核相关：建立 / 过期 / 接受 / 撤销 / 重做

export interface LogEntry {
  id: number
  kind: LogKind
  seq: number | null
  /** 逻辑时间；人工操作为 null（界面显示“手动”） */
  at: number | null
  message: string
}

/** 批次接受后可撤销/重做的一步操作（按一次“接受所选”记录一步） */
export interface BatchHistoryStep {
  batchId: string
  /** 本次接受的 seq（接受顺序） */
  seqs: number[]
  /** 每个被接受片段应用前的完整快照，撤销时逐条还原 */
  before: Record<
    number,
    {
      segment: SubtitleSegment | null
      /** 应用前该 seq 是否登记着旧冲突 */
      hadConflict: boolean
      conflict: Conflict | null
    }
  >
  /** 应用后的机器内容，重做时若护栏通过直接使用 */
  after: { seq: number; text: string; version: number }[]
}

/** 控制台全部状态。纯数据、可深比较，reset 后必须与初始状态完全一致。 */
export interface ConsoleState {
  segments: Record<number, SubtitleSegment>
  /** 已见过的事件 ID 集合，用于事件级去重 */
  seenEventIds: Record<string, true>
  conflicts: Conflict[]
  log: LogEntry[]
  nextLogId: number
  /** 当前开放收集 / 待复核的批次，同一时刻至多一个 */
  currentBatch: ReviewBatch | null
  /** 已复核完毕的批次（仅保留最近若干条用于审计展示） */
  batchHistory: ReviewBatch[]
  /** 接受操作的撤销栈（最新在末尾） */
  undoStack: BatchHistoryStep[]
  /** 被撤销的操作，供重做；再次接受后清空 */
  redoStack: BatchHistoryStep[]
}
