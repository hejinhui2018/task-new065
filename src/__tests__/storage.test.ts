import { describe, expect, it } from 'vitest'
import { consoleReducer, createInitialState, type ConsoleAction } from '../consoleReducer'
import { MemoryStorage, loadState, saveState, STORAGE_KEY } from '../storage'
import type { ConsoleState, SubtitleEvent } from '../types'

/**
 * 刷新恢复测试：复核现场（批次缓冲、勾选、已接受结果、撤销栈）
 * 序列化到存储后可无损恢复；坏数据安全回退到初始状态。
 */

function ev(id: string, seq: number, version: number, text: string, batchId?: string): SubtitleEvent {
  return { id, seq, version, kind: version === 1 ? 'create' : 'revision', text, ...(batchId ? { batchId } : {}) }
}

const BID = 'batch-post-live'
function dispatchAll(state: ConsoleState, actions: ConsoleAction[]): ConsoleState {
  return actions.reduce(consoleReducer, state)
}

/** 构造一个“批次待复核 + 已部分接受”的现场 */
function midReviewState(): ConsoleState {
  return dispatchAll(createInitialState(), [
    { type: 'ingest', event: ev('e101', 101, 1, '原文101'), receivedAt: 0 },
    { type: 'ingest', event: ev('e103', 103, 1, '原文103'), receivedAt: 100 },
    { type: 'batch-begin', id: BID, at: 13000 },
    { type: 'ingest', event: ev('e104', 104, 1, '新增104', BID), receivedAt: 13000 },
    { type: 'ingest', event: ev('e101v2', 101, 2, '改写101', BID), receivedAt: 13000 },
    { type: 'batch-end', id: BID, at: 13000 },
    // 运营排除 #101，只接受 #104
    { type: 'batch-toggle', seq: 101 },
    { type: 'batch-accept', mode: 'selected' },
  ])
}

describe('刷新恢复', () => {
  it('待复核批次、部分接受结果与撤销栈序列化后无损恢复', () => {
    const storage = new MemoryStorage()
    const before = midReviewState()
    saveState(storage, before)

    const after = loadState(storage)
    expect(after).toEqual(before)
    // 关键语义逐项确认
    expect(after.segments[104].text).toBe('新增104')
    expect(after.segments[101].version).toBe(1)
    expect(after.currentBatch!.phase).toBe('pending')
    expect(after.currentBatch!.entries[101].text).toBe('改写101')
    expect(after.undoStack).toHaveLength(1)

    // 恢复后仍可继续操作：撤销可以还原刷新前的接受
    const undone = consoleReducer(after, { type: 'batch-undo' })
    expect(undone.segments[104]).toBeUndefined()
    expect(undone.currentBatch!.selected).toEqual([104])
    // 刷新前被排除的 #101 维持排除，撤销不会替用户改主意
    expect(undone.currentBatch!.entries[101]).toBeDefined()
  })

  it('刷新时停在收集阶段的批次被提升为待复核，已收条目不丢', () => {
    const storage = new MemoryStorage()
    const open = dispatchAll(createInitialState(), [
      { type: 'batch-begin', id: BID, at: 13000 },
      { type: 'ingest', event: ev('e104', 104, 1, '新增104', BID), receivedAt: 13000 },
    ])
    expect(open.currentBatch!.phase).toBe('open')
    saveState(storage, open)

    const after = loadState(storage)
    expect(after.currentBatch!.phase).toBe('pending')
    expect(after.currentBatch!.entries[104].text).toBe('新增104')
    expect(after.currentBatch!.selected).toEqual([104])
  })

  it('已完成批次与排除统计恢复后仍可审计', () => {
    const storage = new MemoryStorage()
    const done = dispatchAll(midReviewState(), [{ type: 'batch-accept', mode: 'finish' }])
    saveState(storage, done)

    const after = loadState(storage)
    expect(after.currentBatch).toBeNull()
    expect(after.batchHistory).toHaveLength(1)
    expect(after.batchHistory[0]).toMatchObject({
      id: BID,
      phase: 'applied',
      appliedCount: 1,
      excludedCount: 1,
    })
  })

  it('空存储与损坏数据安全回退初始状态，不抛错', () => {
    expect(loadState(new MemoryStorage())).toEqual(createInitialState())

    const bad = new MemoryStorage()
    bad.setItem(STORAGE_KEY, '{not-json')
    expect(loadState(bad)).toEqual(createInitialState())

    const wrongShape = new MemoryStorage()
    wrongShape.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state: { segments: null } }))
    expect(loadState(wrongShape)).toEqual(createInitialState())

    const futureVersion = new MemoryStorage()
    futureVersion.setItem(STORAGE_KEY, JSON.stringify({ version: 999, state: {} }))
    expect(loadState(futureVersion)).toEqual(createInitialState())
  })
})
