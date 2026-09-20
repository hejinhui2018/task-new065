import type {
  BatchEntry,
  BatchItemKind,
  ConsoleState,
  ReviewBatch,
  SubtitleSegment,
} from './types'

/**
 * 批次复核的纯函数：条目归并、分类、选择规则全部在这里，
 * reducer 只负责搬运，保证同状态同输入结果可重放。
 */

/** 把一条事件并入批次缓冲：同 seq 只保留版本最高的一条，重发事件记入 eventIds */
export function mergeEntry(
  entries: Record<number, BatchEntry>,
  incoming: { id: string; seq: number; version: number; text: string; receivedAt: number | null },
): Record<number, BatchEntry> {
  const prev = entries[incoming.seq]
  if (!prev || incoming.version > prev.version) {
    return {
      ...entries,
      [incoming.seq]: {
        seq: incoming.seq,
        text: incoming.text,
        version: incoming.version,
        eventIds: [incoming.id],
        receivedAt: incoming.receivedAt,
      },
    }
  }
  if (incoming.version === prev.version) {
    // 同版本重发（可能 ID 不同）：不覆盖内容，只登记重复到达
    const eventIds = prev.eventIds.includes(incoming.id)
      ? prev.eventIds
      : [...prev.eventIds, incoming.id]
    return {
      ...entries,
      [incoming.seq]: {
        ...prev,
        eventIds,
        receivedAt: later(prev.receivedAt, incoming.receivedAt),
      },
    }
  }
  // 更旧版本：缓冲内已有更高版本，原样保留
  return entries
}

function later(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/** 批次条目相对当前时间线的分类 */
export function classifyEntry(
  entry: BatchEntry,
  seg: SubtitleSegment | undefined,
): BatchItemKind {
  if (!seg) return 'new'
  if (seg.locked) return 'conflict'
  if (entry.version < seg.version) return 'noop'
  if (entry.version === seg.version) {
    // 同版本且文本一致 => 无变化；同版本异文属异常数据，按无变化处理不回写
    return 'noop'
  }
  // entry.version > seg.version
  if (entry.text === seg.text) return 'noop'
  return 'rewrite'
}

export interface BatchViewItem extends BatchEntry {
  kind: BatchItemKind
  /** 锁定片段：强制排除，需先在时间线解锁才能纳入 */
  lockedOut: boolean
  /** 当前是否被勾选接受（只对可接受条目有意义） */
  selected: boolean
  /** 时间线上的当前片段（new 时为 null） */
  current: SubtitleSegment | null
}

export interface BatchView {
  batch: ReviewBatch
  items: BatchViewItem[]
  /** 可勾选条目（新增/改写），按序号排序 */
  acceptable: BatchViewItem[]
  newCount: number
  rewriteCount: number
  conflictCount: number
  noopCount: number
  /** 重复到达次数（条目内重发副本数减一之和） */
  duplicateCount: number
  /** 全部可接受条目均已勾选 */
  allSelected: boolean
  /** 至少有一条勾选，可执行接受 */
  hasSelection: boolean
}

/** 由状态实时派生批次视图：分类永远基于最新时间线，不缓存旧结论 */
export function batchView(batch: ReviewBatch, state: ConsoleState): BatchView {
  const selectedSet = new Set(batch.selected)
  const items: BatchViewItem[] = Object.values(batch.entries)
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => {
      const current = state.segments[entry.seq] ?? null
      const kind = classifyEntry(entry, state.segments[entry.seq])
      return {
        ...entry,
        kind,
        current,
        lockedOut: kind === 'conflict',
        selected: selectedSet.has(entry.seq),
      }
    })

  const acceptable = items.filter((it) => it.kind === 'new' || it.kind === 'rewrite')
  const counts = {
    newCount: items.filter((it) => it.kind === 'new').length,
    rewriteCount: items.filter((it) => it.kind === 'rewrite').length,
    conflictCount: items.filter((it) => it.kind === 'conflict').length,
    noopCount: items.filter((it) => it.kind === 'noop').length,
  }
  const duplicateCount = items.reduce((sum, it) => sum + (it.eventIds.length - 1), 0)

  return {
    batch,
    items,
    acceptable,
    ...counts,
    duplicateCount,
    allSelected: acceptable.length > 0 && acceptable.every((it) => it.selected),
    hasSelection: acceptable.some((it) => it.selected),
  }
}

/**
 * 重算勾选集合：保留仍为同一 seq 且仍可接受（未锁定、仍属新增/改写）的选择。
 * 条目内容若发生变化（版本升高），旧选择按“不静默套用旧选择”原则一并移除，
 * 需要运营在新内容上重新勾选。
 */
export function reconcileSelection(
  entries: Record<number, BatchEntry>,
  previous: Record<number, BatchEntry>,
  selected: number[],
  state: ConsoleState,
): number[] {
  return selected.filter((seq) => {
    const entry = entries[seq]
    if (!entry) return false
    const prev = previous[seq]
    // 内容版本变了（复核中到达的更新）：旧选择作废
    if (!prev || prev.version !== entry.version || prev.text !== entry.text) return false
    const seg = state.segments[seq]
    const kind = classifyEntry(entry, seg)
    return kind === 'new' || kind === 'rewrite'
  })
}

/** 全部可接受条目的 seq */
export function acceptableSeqs(batch: ReviewBatch, state: ConsoleState): number[] {
  return Object.values(batch.entries)
    .filter((entry) => {
      const kind = classifyEntry(entry, state.segments[entry.seq])
      return kind === 'new' || kind === 'rewrite'
    })
    .map((entry) => entry.seq)
    .sort((a, b) => a - b)
}
