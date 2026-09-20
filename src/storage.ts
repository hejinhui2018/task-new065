import { createInitialState } from './consoleReducer'
import type { ConsoleState } from './types'

/**
 * 本地状态持久化：刷新页面后时间线、冲突、批次复核进度与撤销栈保持一致。
 * 仅依赖 localStorage（可缺失，如隐私模式），读写失败一律安全降级为初始状态。
 */

const STORAGE_KEY = 'subtitle-qc-console:v1'

export function loadState(): ConsoleState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createInitialState()
    const parsed = JSON.parse(raw) as unknown
    if (!isValidState(parsed)) return createInitialState()
    return parsed
  } catch {
    return createInitialState()
  }
}

export function saveState(state: ConsoleState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 配额不足或存储被禁用：放弃持久化，不影响内存中的正常使用
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 同上
  }
}

/** 结构兜底校验：持久化数据来自旧版本或被外部改写时不直接信任 */
function isValidState(value: unknown): value is ConsoleState {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.segments === 'object' &&
    s.segments !== null &&
    typeof s.seenEventIds === 'object' &&
    Array.isArray(s.conflicts) &&
    Array.isArray(s.log) &&
    typeof s.nextLogId === 'number'
  )
}
