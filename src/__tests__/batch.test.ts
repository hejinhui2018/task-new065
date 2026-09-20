import { describe, expect, it } from 'vitest'
import { consoleReducer, createInitialState, type ConsoleAction } from '../consoleReducer'
import { batchView } from '../batch'
import { gaps, onAirSeq, sortedSegments } from '../selectors'
import type { ConsoleState, SubtitleEvent } from '../types'

/**
 * 批次复核的核心语义测试：
 * 重复批次不重复应用、晚到片段触发过期重算、锁定冲突默认排除需解锁、
 * 部分接受/整批接受、撤销重做、批次外常规流不受影响。
 */

function ev(
  id: string,
  seq: number,
  version: number,
  text: string,
  kind: 'create' | 'revision' = 'create',
  batchId?: string,
): SubtitleEvent {
  return { id, seq, version, kind, text, ...(batchId ? { batchId } : {}) }
}

const BID = 'batch-post-live'

function begin(state: ConsoleState, at: number | null = 13000): ConsoleState {
  return consoleReducer(state, { type: 'batch-begin', id: BID, at })
}
function end(state: ConsoleState, at: number | null = 13000): ConsoleState {
  return consoleReducer(state, { type: 'batch-end', id: BID, at })
}
function ingest(
  state: ConsoleState,
  event: SubtitleEvent,
  at: number | null = 13000,
): ConsoleState {
  return consoleReducer(state, { type: 'ingest', event, receivedAt: at })
}
function act(state: ConsoleState, action: ConsoleAction): ConsoleState {
  return consoleReducer(state, action)
}

/** 先铺好直播段：#101 v1、#103 v1、#102 v1（顺序：101→103→102 晚到补齐） */
function liveState(): ConsoleState {
  let s = createInitialState()
  s = ingest(s, ev('e101', 101, 1, '直播原文101'), 0)
  s = ingest(s, ev('e103', 103, 1, '直播原文103'), 1500)
  s = ingest(s, ev('e102', 102, 1, '直播原文102'), 4500)
  return s
}

/** 补发批次进入待复核：#104 新增、#101 v2 改写、#103 同内容无变化 */
function pendingBatch(options: { locked102?: boolean } = {}): ConsoleState {
  let s = liveState()
  if (options.locked102) {
    s = act(s, { type: 'edit', seq: 102, text: '人工锁定稿102' })
    s = act(s, { type: 'toggle-lock', seq: 102 })
  }
  s = begin(s)
  s = ingest(s, ev('e104', 104, 1, '新增结尾104', 'create', BID))
  s = ingest(s, ev('e101v2', 101, 2, '改写后的101', 'revision', BID))
  s = ingest(s, ev('e103-resend', 103, 1, '直播原文103', 'revision', BID))
  if (options.locked102) {
    s = ingest(s, ev('e102v2', 102, 2, '机器修订102', 'revision', BID))
  }
  s = end(s)
  return s
}

describe('批次收集与分类', () => {
  it('批次开放期间事件不落时间线，收齐后按新增/改写/冲突/无变化分类', () => {
    const s = pendingBatch({ locked102: true })
    expect(s.currentBatch).not.toBeNull()
    expect(s.currentBatch!.phase).toBe('pending')

    // 缓冲期间时间线未被改动
    expect(sortedSegments(s).map((x) => x.seq)).toEqual([101, 102, 103])
    expect(s.segments[101].version).toBe(1)

    const view = batchView(s.currentBatch!, s)
    const bySeq = Object.fromEntries(view.items.map((it) => [it.seq, it.kind]))
    expect(bySeq).toEqual({
      101: 'rewrite',
      102: 'conflict',
      103: 'noop',
      104: 'new',
    })
    // 默认勾选只含新增/改写，锁定冲突与无变化被排除
    expect(s.currentBatch!.selected.sort((a, b) => a - b)).toEqual([101, 104])
  })
})

describe('重复批次 / 重复事件', () => {
  it('批次 begin/end 重发是幂等的，不会产生第二个批次', () => {
    let s = begin(liveState())
    s = ingest(s, ev('e104', 104, 1, '新增104', 'create', BID))
    s = begin(s) // 网络重发 begin
    s = end(s)
    s = end(s) // 重发 end
    expect(s.currentBatch!.phase).toBe('pending')
    expect(s.batchHistory).toHaveLength(0)
  })

  it('批次内同事件 ID 重发与同内容重发都不重复，接受时只应用一次', () => {
    let s = begin(liveState())
    s = ingest(s, ev('e104', 104, 1, '新增104', 'create', BID))
    s = ingest(s, ev('e104', 104, 1, '新增104', 'create', BID)) // 同 ID 重发
    s = ingest(s, ev('e104b', 104, 1, '新增104', 'create', BID)) // 不同 ID 同内容
    s = end(s)

    const view = batchView(s.currentBatch!, s)
    expect(view.items).toHaveLength(1)
    expect(view.items[0].eventIds).toEqual(['e104', 'e104b'])
    expect(view.duplicateCount).toBe(1)
    expect(s.log.filter((l) => l.kind === 'duplicate').length).toBeGreaterThanOrEqual(2)

    s = act(s, { type: 'batch-accept', mode: 'all' })
    expect(sortedSegments(s).map((x) => x.seq)).toContain(104)
    // 时间线里 #104 只有一条
    expect(s.segments[104].text).toBe('新增104')
  })

  it('整个批次（begin+事件）被播放器链路重放时，seenEventIds 阻止事件二次套用', () => {
    // 模拟刷新后播放器从头重放：先 hydrate 成“批次已接受 #104”的状态，
    // 再次收到同一事件 ID 必须被去重，不能产生第二条
    let s = pendingBatch()
    s = act(s, { type: 'batch-toggle', seq: 101 }) // 只接受 #104
    s = act(s, { type: 'batch-accept', mode: 'selected' })
    expect(s.segments[104]).toBeDefined()

    const replay = ingest(s, ev('e104', 104, 1, '新增结尾104', 'create', BID), 99000)
    expect(replay.segments[104]).toBe(s.segments[104])
    expect(replay.log[replay.log.length - 1].kind).toBe('duplicate')
  })

  it('批次完成后整批重发：不再新开批次，内容不重复应用', () => {
    let s = act(pendingBatch(), { type: 'batch-accept', mode: 'all' })
    expect(s.currentBatch).toBeNull()
    const finished = s

    // 网络层把整组 begin + 事件又投递一遍
    s = act(s, { type: 'batch-begin', id: BID, at: 99000 })
    expect(s.currentBatch).toBeNull()
    s = ingest(s, ev('e104', 104, 1, '新增结尾104', 'create', BID), 99000)
    s = ingest(s, ev('e101v2', 101, 2, '改写后的101', 'revision', BID), 99000)
    // 时间线与完成时逐位一致，无重复片段
    expect(sortedSegments(s)).toEqual(sortedSegments(finished))
    expect(s.batchHistory).toHaveLength(1)
    expect(s.log.some((l) => l.message.includes('整批重发已忽略'))).toBe(true)
  })
})

describe('晚到片段与过期重算', () => {
  it('复核进行中同批次片段晚到：标记过期、并入重算、旧勾选不静默套用', () => {
    let s = pendingBatch() // 勾选 [101, 104]
    expect(s.currentBatch!.selected.sort()).toEqual([101, 104])

    // 对 #101 的旧内容先取消再重新勾选，确保有明确旧选择
    // 晚到：#101 v3（内容更新）和 #105 全新片段
    s = ingest(s, ev('e101v3', 101, 3, '再次改写的101', 'revision', BID), 20000)
    s = ingest(s, ev('e105', 105, 1, '晚到新增105', 'create', BID), 20000)

    const batch = s.currentBatch!
    expect(batch.staleSince).toBe(20000)
    expect(batch.staleCount).toBe(2)
    // #101 的旧勾选（针对 v2）随内容变化作废；#104 内容未变保留；#105 新条目不自动替用户勾选
    expect(batch.selected).toEqual([104])
    expect(batch.entries[101].version).toBe(3)
    expect(batch.entries[105].text).toBe('晚到新增105')
  })

  it('过期重算后接受，落的是新内容而不是旧选择对应的旧文本', () => {
    let s = pendingBatch()
    s = ingest(s, ev('e101v3', 101, 3, '再次改写的101', 'revision', BID), 20000)
    // 旧勾选 [101,104] 中 101 已作废，只剩 104；用户在新内容上重新全选
    s = act(s, { type: 'batch-select-all', selected: true })
    expect(s.currentBatch!.selected.sort()).toEqual([101, 104])
    s = act(s, { type: 'batch-accept', mode: 'all' })
    expect(s.segments[101].version).toBe(3)
    expect(s.segments[101].text).toBe('再次改写的101')
  })

  it('批次缓冲中的晚到新增片段接受后补回时间线缺口', () => {
    let s = liveState() // 101,102,103
    s = begin(s)
    // 序号更小的全新片段 100（晚到）
    s = ingest(s, ev('e100', 100, 1, '晚到的100', 'create', BID))
    s = end(s)
    expect(gaps(s)).toEqual([]) // 接受前还没落位，不改变现有缺口视图
    s = act(s, { type: 'batch-accept', mode: 'all' })
    expect(sortedSegments(s).map((x) => x.seq)).toEqual([100, 101, 102, 103])
    expect(s.log.some((l) => l.kind === 'backfilled' && l.seq === 100)).toBe(true)
  })
})

describe('锁定冲突', () => {
  it('锁定片段默认排除且不可勾选，解锁后自动纳入批次', () => {
    let s = pendingBatch({ locked102: true })
    expect(s.currentBatch!.selected).not.toContain(102)
    // 直接 toggle 锁定项无效
    s = act(s, { type: 'batch-toggle', seq: 102 })
    expect(s.currentBatch!.selected).not.toContain(102)

    // 整批接受也不能带走锁定项
    s = act(s, { type: 'batch-accept', mode: 'all' })
    expect(s.segments[102].text).toBe('人工锁定稿102')
    expect(s.segments[102].locked).toBe(true)

    // 批次因锁定项仍在复核中（pendant 未结束）
    expect(s.currentBatch).not.toBeNull()
    const view = batchView(s.currentBatch!, s)
    expect(view.conflictCount).toBe(1)

    // 明确解锁：自动纳入
    s = act(s, { type: 'toggle-lock', seq: 102 })
    expect(s.currentBatch!.selected).toContain(102)
    s = act(s, { type: 'batch-accept', mode: 'finish' })
    expect(s.segments[102].text).toBe('机器修订102')
    expect(s.segments[102].version).toBe(2)
    expect(s.segments[102].locked).toBe(false)
    expect(s.currentBatch).toBeNull()
    expect(s.batchHistory[0].excludedCount).toBe(1) // #103 无变化始终排除
  })

  it('接受批次不会解锁或覆盖锁定片段，也不登记普通冲突', () => {
    const s0 = pendingBatch({ locked102: true })
    // 锁定项走批次通道列示，不应出现在常规冲突面板
    expect(s0.conflicts).toEqual([])

    // 整批接受仍有锁定冲突：不静默收尾
    const afterAll = act(s0, { type: 'batch-accept', mode: 'all' })
    expect(afterAll.currentBatch).not.toBeNull()
    expect(afterAll.segments[102].text).toBe('人工锁定稿102')

    // 运营显式「排除其余、完成复核」才收尾，锁定内容原样保留
    const afterFinish = act(s0, { type: 'batch-accept', mode: 'finish' })
    expect(afterFinish.currentBatch).toBeNull()
    expect(afterFinish.segments[102].text).toBe('人工锁定稿102')
    expect(afterFinish.segments[102].locked).toBe(true)
    // 接受 101/104，排除 102（锁定）与 103（无变化）
    expect(afterFinish.batchHistory[0].appliedCount).toBe(2)
    expect(afterFinish.batchHistory[0].excludedCount).toBe(2)
  })
})

describe('部分接受 / 整批接受', () => {
  it('部分接受只应用勾选条目，其余继续待复核，时间线与批次状态一致', () => {
    let s = pendingBatch()
    // 只接受新增 #104，排除改写 #101
    s = act(s, { type: 'batch-toggle', seq: 101 })
    expect(s.currentBatch!.selected).toEqual([104])
    s = act(s, { type: 'batch-accept', mode: 'selected' })

    expect(s.segments[104].text).toBe('新增结尾104')
    expect(s.segments[101].version).toBe(1) // 未被改写
    expect(s.currentBatch!.phase).toBe('pending')
    expect(onAirSeq(s)).toBe(104)
    expect(s.undoStack).toHaveLength(1)

    // 继续勾选剩余改写并收尾
    s = act(s, { type: 'batch-toggle', seq: 101 })
    s = act(s, { type: 'batch-accept', mode: 'finish' })
    expect(s.currentBatch).toBeNull()
    expect(s.segments[101].version).toBe(2)
    const done = s.batchHistory[0]
    expect(done.appliedCount).toBe(2)
    expect(done.excludedCount).toBe(1) // #103 无变化
  })

  it('整批接受一次性应用全部可接受条目，无变化项不写时间线', () => {
    let s = pendingBatch()
    s = act(s, { type: 'batch-accept', mode: 'all' })
    expect(s.currentBatch).toBeNull()
    expect(s.segments[101].text).toBe('改写后的101')
    expect(s.segments[103].text).toBe('直播原文103') // 无变化：原样
    expect(s.segments[104].text).toBe('新增结尾104')
    expect(s.batchHistory[0].appliedCount).toBe(2)
  })

  it('复核中人工编辑条目后机器版本不再替其勾选，重新勾选并接受才会覆盖人工稿', () => {
    let s = pendingBatch()
    s = act(s, { type: 'batch-toggle', seq: 101 })
    s = act(s, { type: 'batch-accept', mode: 'selected' }) // 只接受 #104
    // 人工直接改 #101（未锁定）：模拟复核中时间线变化
    s = act(s, { type: 'edit', seq: 101, text: '人工抢先改了101' })
    // 人工改动后该条被移出勾选，finish 不会静默覆盖人工稿
    expect(s.currentBatch!.selected).toEqual([])
    s = act(s, { type: 'batch-accept', mode: 'finish' })
    expect(s.segments[101].text).toBe('人工抢先改了101')
    expect(s.currentBatch).toBeNull() // 人工选择排除机器稿，批次收尾

    // 若重新勾选再接受，则明确覆盖
    let s2 = pendingBatch()
    s2 = act(s2, { type: 'batch-toggle', seq: 101 })
    s2 = act(s2, { type: 'batch-accept', mode: 'selected' }) // #104
    s2 = act(s2, { type: 'edit', seq: 101, text: '人工抢先改了101' })
    s2 = act(s2, { type: 'batch-toggle', seq: 101 }) // 运营看过人工稿后仍决定采用机器版本
    s2 = act(s2, { type: 'batch-accept', mode: 'finish' })
    expect(s2.segments[101].text).toBe('改写后的101')
  })
})

describe('撤销 / 重做', () => {
  it('整批接受后撤销，时间线、冲突、批次状态全部回到接受前，重做可还原', () => {
    const before = pendingBatch()
    let s = act(before, { type: 'batch-accept', mode: 'all' })
    expect(s.segments[104]).toBeDefined()

    s = act(s, { type: 'batch-undo' })
    expect(s.segments[104]).toBeUndefined() // 新增条目被删除
    expect(s.segments[101].version).toBe(1) // 改写还原
    expect(s.currentBatch!.phase).toBe('pending')
    expect(s.currentBatch!.selected.sort()).toEqual([101, 104])
    expect(s.redoStack).toHaveLength(1)

    s = act(s, { type: 'batch-redo' })
    expect(s.segments[104].text).toBe('新增结尾104')
    expect(s.segments[101].version).toBe(2)
    expect(s.currentBatch).toBeNull()
  })

  it('撤销后人工改动相关片段，重做护栏拒绝静默套用', () => {
    let s = act(pendingBatch(), { type: 'batch-accept', mode: 'all' })
    s = act(s, { type: 'batch-undo' })
    // 撤销后人工把 #101 改成别的内容
    s = act(s, { type: 'edit', seq: 101, text: '人工另起炉灶' })
    const snapshot = s
    s = act(s, { type: 'batch-redo' })
    expect(s).toEqual(snapshot) // 护栏生效：状态不变
    expect(s.segments[101].text).toBe('人工另起炉灶')
  })

  it('部分接受可逐步撤销，LIFO 顺序还原每一步', () => {
    let s = pendingBatch()
    s = act(s, { type: 'batch-toggle', seq: 101 })
    s = act(s, { type: 'batch-accept', mode: 'selected' }) // 第一步：#104
    s = act(s, { type: 'batch-toggle', seq: 101 })
    s = act(s, { type: 'batch-accept', mode: 'finish' }) // 第二步：#101，收尾
    expect(s.segments[101].version).toBe(2)
    expect(s.segments[104]).toBeDefined()

    s = act(s, { type: 'batch-undo' }) // 撤销第二步
    expect(s.segments[101].version).toBe(1)
    expect(s.segments[104]).toBeDefined()
    expect(s.currentBatch!.phase).toBe('pending')

    s = act(s, { type: 'batch-undo' }) // 撤销第一步
    expect(s.segments[104]).toBeUndefined()
  })

  it('新接受会清空重做栈', () => {
    let s = act(pendingBatch(), { type: 'batch-accept', mode: 'all' })
    s = act(s, { type: 'batch-undo' })
    expect(s.redoStack).toHaveLength(1)
    s = act(s, { type: 'batch-toggle', seq: 101 }) // 改变选择后只接受 #104
    s = act(s, { type: 'batch-accept', mode: 'selected' })
    expect(s.redoStack).toHaveLength(0)
  })
})

describe('批次与常规流共存', () => {
  it('复核进行中，不属于该批次的事件仍按常规通道直接落位', () => {
    let s = pendingBatch()
    s = ingest(s, ev('e200', 200, 1, '常规流新片段'), 16000)
    expect(s.segments[200].text).toBe('常规流新片段')
    // 常规修订未锁定片段直接应用，不进批次
    s = ingest(s, ev('e103v2', 103, 2, '常规修订103', 'revision'), 17000)
    expect(s.segments[103].version).toBe(2)
  })

  it('批次内过期版本（低于时间线当前版本）被忽略', () => {
    let s = liveState()
    // 直播流先把 101 升到 v3
    s = ingest(s, ev('e101v3-direct', 101, 3, '已经是v3', 'revision'))
    s = begin(s)
    s = ingest(s, ev('e101v2-late', 101, 2, '迟到的v2', 'revision', BID))
    s = end(s)
    const view = batchView(s.currentBatch!, s)
    expect(view.items.find((it) => it.seq === 101)).toBeUndefined()
    expect(s.segments[101].version).toBe(3)
    expect(s.log.some((l) => l.kind === 'stale')).toBe(true)
  })
})
