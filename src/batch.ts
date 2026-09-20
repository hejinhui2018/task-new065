import type {
  BatchChangeKind,
  BatchItem,
  ConsoleState,
  ReviewBatch,
  SubtitleEvent,
  SubtitleSegment,
} from './types'

/**
 * 批次复核纯逻辑：批次事件归一化、条目分类、相对当前时间线重算。
 * 全部为纯函数，不读时钟、不碰存储，保证可稳定重放与测试。
 */

/** 同一序号只保留最高版本的事件（版本相同保留先到达的一条），按序号排序 */
export function normalizeBatchEvents(events: SubtitleEvent[]): SubtitleEvent[] {
  const bySeq = new Map<number, SubtitleEvent>()
  for (const event of events) {
    const kept = bySeq.get(event.seq)
    if (!kept || event.version > kept.version) {
      bySeq.set(event.seq, event)
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** 条目是否可被勾选：新增/改写且未锁定；冲突（锁定）、无变化、过期均不可勾选 */
export function isSelectableItem(item: Pick<BatchItem, 'kind' | 'locked'>): boolean {
  return !item.locked && (item.kind === 'added' || item.kind === 'revised')
}

function classify(
  event: SubtitleEvent,
  existing: SubtitleSegment | undefined,
): { kind: BatchChangeKind; locked: boolean } {
  if (!existing) return { kind: 'added', locked: false }
  if (event.version < existing.version) return { kind: 'stale', locked: existing.locked }
  if (event.version === existing.version) {
    return {
      kind: event.text === existing.text ? 'unchanged' : 'stale',
      locked: existing.locked,
    }
  }
  // 更新的机器版本：锁定片段是冲突，否则是改写
  return { kind: existing.locked ? 'conflict' : 'revised', locked: existing.locked }
}

export interface RecomputeOptions {
  /** 上一轮条目记录的勾选意愿，按序号保存 */
  prevSelection?: Map<number, boolean>
  /** 明确解锁后强制勾选的序号（用户的显式意愿） */
  forceSelected?: Set<number>
  /** 机器更新导致的重算：丢弃全部旧勾选，避免静默套用旧选择 */
  resetSelection?: boolean
  /** 已应用的事件 ID 不再出现在候选列表中 */
  appliedEventIds?: Set<string>
}

/** 由批次原始事件 + 当前时间线计算候选条目列表 */
export function computeItems(
  events: SubtitleEvent[],
  segments: Record<number, SubtitleSegment>,
  options: RecomputeOptions = {},
): BatchItem[] {
  const applied = options.appliedEventIds ?? new Set<string>()
  const items: BatchItem[] = []
  for (const event of normalizeBatchEvents(events)) {
    if (applied.has(event.id)) continue
    const existing = segments[event.seq]
    const { kind, locked } = classify(event, existing)
    const selectable = isSelectableItem({ kind, locked })
    const wasSelected = !options.resetSelection && options.prevSelection?.get(event.seq) === true
    const forced = options.forceSelected?.has(event.seq) === true
    items.push({
      seq: event.seq,
      eventId: event.id,
      incomingVersion: event.version,
      incomingText: event.text,
      kind,
      locked,
      currentText: existing ? existing.text : null,
      currentVersion: existing ? existing.version : null,
      selected: selectable && (forced || wasSelected),
    })
  }
  return items
}

export function selectionMap(items: BatchItem[]): Map<number, boolean> {
  const map = new Map<number, boolean>()
  for (const item of items) map.set(item.seq, item.selected)
  return map
}

/** 用当前时间线重算进行中的批次；返回新状态（无批次时原样返回） */
export function recomputeBatch(
  state: ConsoleState,
  options: RecomputeOptions = {},
): ConsoleState {
  const batch = state.activeBatch
  if (!batch) return state
  const items = computeItems(batch.events, state.segments, {
    prevSelection: selectionMap(batch.items),
    appliedEventIds: new Set(batch.appliedEventIds),
    ...options,
  })
  return { ...state, activeBatch: { ...batch, items } }
}

/** 批次摘要计数，供面板标题与日志使用 */
export function summarizeItems(items: BatchItem[]): {
  added: number
  revised: number
  conflict: number
  unchanged: number
  stale: number
  selectable: number
  selected: number
} {
  const summary = { added: 0, revised: 0, conflict: 0, unchanged: 0, stale: 0, selectable: 0, selected: 0 }
  for (const item of items) {
    summary[item.kind] += 1
    if (isSelectableItem(item)) {
      summary.selectable += 1
      if (item.selected) summary.selected += 1
    }
  }
  return summary
}

export function summarizeBatch(batch: ReviewBatch): ReturnType<typeof summarizeItems> {
  return summarizeItems(batch.items)
}
