import { acceptableSeqs } from './batch'
import { createInitialState } from './consoleReducer'
import type { ConsoleState, LogEntry, ReviewBatch, SubtitleSegment } from './types'

/**
 * 刷新恢复：把复核现场序列化到可注入的 Storage（生产用 localStorage，
 * 测试用内存假实现）。状态本身是纯数据，但读取来源不可信，
 * 恢复前必须做结构校验，坏数据一律回退到初始状态。
 */

export const STORAGE_KEY = 'subtitle-qc-console:v1'
const STORAGE_VERSION = 1

interface PersistedEnvelope {
  version: number
  state: unknown
}

/** 测试与 SSR 场景使用的内存存储 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

export function saveState(storage: Storage, state: ConsoleState, key: string = STORAGE_KEY): void {
  const envelope: PersistedEnvelope = { version: STORAGE_VERSION, state }
  storage.setItem(key, JSON.stringify(envelope))
}

export function loadState(storage: Storage, key: string = STORAGE_KEY): ConsoleState {
  const raw = storage.getItem(key)
  if (!raw) return createInitialState()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return createInitialState()
  }
  if (!isEnvelope(parsed)) return createInitialState()
  if (!isConsoleState(parsed.state)) {
    // 结构不合法（旧版本/损坏）：不恢复，但保留初始干净状态
    return createInitialState()
  }
  return canonicalize(parsed.state)
}

/**
 * 恢复后的规范化：刷新时批次若仍停在 open（结束边界尚未到达），
 * 之后也不会再有 end 动作把它转入复核，直接提升为 pending，
 * 已收到的条目不丢、按最新时间线重算默认勾选。
 */
function canonicalize(state: ConsoleState): ConsoleState {
  const batch = state.currentBatch
  if (!batch || batch.phase !== 'open') return state
  const pending: ReviewBatch = {
    ...batch,
    phase: 'pending',
    selected: acceptableSeqs(batch, state),
  }
  return { ...state, currentBatch: pending }
}

function isEnvelope(value: unknown): value is PersistedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === STORAGE_VERSION &&
    'state' in value
  )
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isSegment(value: unknown): value is SubtitleSegment {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isNumber(v.seq) &&
    isString(v.text) &&
    isNumber(v.version) &&
    (v.origin === 'machine' || v.origin === 'manual') &&
    typeof v.locked === 'boolean'
  )
}

function isSegmentMap(value: unknown): value is Record<number, SubtitleSegment> {
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value as Record<string, unknown>).every(isSegment)
}

function isLog(value: unknown): value is LogEntry[] {
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    return isNumber(e.id) && isString(e.kind) && isString(e.message)
  })
}

function isBatch(value: unknown): value is ReviewBatch {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  if (!isString(b.id) || !['open', 'pending', 'applied'].includes(String(b.phase))) return false
  if (typeof b.entries !== 'object' || b.entries === null) return false
  const entriesOk = Object.values(b.entries as Record<string, unknown>).every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    return (
      isNumber(e.seq) &&
      isString(e.text) &&
      isNumber(e.version) &&
      Array.isArray(e.eventIds) &&
      e.eventIds.every(isString)
    )
  })
  if (!entriesOk) return false
  return (
    Array.isArray(b.selected) && b.selected.every(isNumber) &&
    Array.isArray(b.accepted) && b.accepted.every(isNumber)
  )
}

function isConsoleState(value: unknown): value is ConsoleState {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    isSegmentMap(s.segments) &&
    typeof s.seenEventIds === 'object' && s.seenEventIds !== null &&
    Array.isArray(s.conflicts) &&
    isLog(s.log) &&
    isNumber(s.nextLogId) &&
    (s.currentBatch === null || isBatch(s.currentBatch)) &&
    Array.isArray(s.batchHistory) && s.batchHistory.every(isBatch) &&
    Array.isArray(s.undoStack) &&
    Array.isArray(s.redoStack)
  )
}
