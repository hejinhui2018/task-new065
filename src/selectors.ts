import type { BatchItem, ConsoleState, ReviewBatch, SubtitleSegment } from './types'
import { isSelectableItem, summarizeItems } from './batch'

/** 派生数据选择器：全部由状态计算，不额外存储，保证 reset 后无残留。 */

export function sortedSegments(state: ConsoleState): SubtitleSegment[] {
  return Object.values(state.segments).sort((a, b) => a.seq - b.seq)
}

/** 从最小到最大序号的完整序号序列（含缺口位置） */
export function seqRange(state: ConsoleState): number[] {
  const keys = Object.keys(state.segments).map(Number)
  if (keys.length === 0) return []
  const min = Math.min(...keys)
  const max = Math.max(...keys)
  const out: number[] = []
  for (let seq = min; seq <= max; seq += 1) out.push(seq)
  return out
}

/** 缺口：已收到范围内缺失的序号 */
export function gaps(state: ConsoleState): number[] {
  return seqRange(state).filter((seq) => !state.segments[seq])
}

/**
 * 当前播出序号：从最小序号起连续完整的最长前缀的末尾。
 * 缺口之后的片段即使已到达也不能播出（内容不连贯）。
 */
export function onAirSeq(state: ConsoleState): number | null {
  const keys = Object.keys(state.segments).map(Number)
  if (keys.length === 0) return null
  let cursor = Math.min(...keys)
  while (state.segments[cursor]) cursor += 1
  return cursor - 1
}

export function onAirSegment(state: ConsoleState): SubtitleSegment | null {
  const seq = onAirSeq(state)
  return seq === null ? null : state.segments[seq]
}

/** 已到达但被缺口阻塞、排在播出序号之后的片段 */
export function upcomingSegments(state: ConsoleState): SubtitleSegment[] {
  const onAir = onAirSeq(state)
  if (onAir === null) return []
  return sortedSegments(state).filter((seg) => seg.seq > onAir)
}

/** 第一个阻塞播出的缺口（紧跟在播出序号之后），无缺口时为 null */
export function firstBlockingGap(state: ConsoleState): number | null {
  const list = gaps(state)
  return list.length > 0 ? list[0] : null
}

export function lockedCount(state: ConsoleState): number {
  return Object.values(state.segments).filter((seg) => seg.locked).length
}

export function duplicateCount(state: ConsoleState): number {
  return state.log.filter((entry) => entry.kind === 'duplicate').length
}

/** 可勾选条目（新增/改写且未锁定），按时间线顺序 */
export function selectableItems(batch: ReviewBatch): BatchItem[] {
  return batch.items.filter(isSelectableItem)
}

export type BatchSummary = ReturnType<typeof summarizeItems>

/** 批次分类计数 + 全选状态，供复核面板标题与按钮使用 */
export function batchSummary(batch: ReviewBatch): BatchSummary & { allSelected: boolean } {
  const summary = summarizeItems(batch.items)
  return { ...summary, allSelected: summary.selectable > 0 && summary.selected === summary.selectable }
}

export function canUndo(state: ConsoleState): boolean {
  return state.past.length > 0
}

export function canRedo(state: ConsoleState): boolean {
  return state.future.length > 0
}

/** 最近一次可撤销动作的描述（用于按钮提示） */
export function undoLabel(state: ConsoleState): string | null {
  const last = state.past[state.past.length - 1]
  return last ? last.label : null
}

export function redoLabel(state: ConsoleState): string | null {
  const last = state.future[state.future.length - 1]
  return last ? last.label : null
}
