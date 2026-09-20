import { afterEach, describe, expect, it, vi } from 'vitest'
import { consoleReducer, createInitialState, type ConsoleAction } from '../consoleReducer'
import { loadState, saveState } from '../storage'
import type { ConsoleState, SubtitleEvent } from '../types'

/** 构造一条机器事件 */
function ev(
  id: string,
  seq: number,
  version: number,
  text: string,
  kind: 'create' | 'revision' = 'create',
): SubtitleEvent {
  return { id, seq, version, kind, text }
}

function ingest(event: SubtitleEvent, receivedAt: number | null = null): ConsoleAction {
  return { type: 'ingest', event, receivedAt }
}

function openBatch(id: string, events: SubtitleEvent[], at: number | null = 12000): ConsoleAction {
  return { type: 'batch-open', id, label: `批次 ${id}`, events, at }
}

function feed(state: ConsoleState, events: SubtitleEvent[]): ConsoleState {
  return events.reduce((s, e) => consoleReducer(s, ingest(e)), state)
}

function itemOf(state: ConsoleState, seq: number) {
  const item = state.activeBatch?.items.find((i) => i.seq === seq)
  if (!item) throw new Error(`批次中找不到 #${seq}`)
  return item
}

/** 安装内存版 localStorage（测试运行在 node 环境） */
function installMemoryStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('批次分类', () => {
  /** #101 未锁定、#102 锁定人工、#103 未锁定、#104 未锁定 */
  function baseState(): ConsoleState {
    let s = feed(createInitialState(), [
      ev('e101', 101, 1, '101原文'),
      ev('e102', 102, 1, '102机器'),
      ev('e103', 103, 1, '103原文'),
      ev('e104', 104, 1, '完全相同'),
    ])
    s = consoleReducer(s, { type: 'edit', seq: 102, text: '102人工稿' })
    s = consoleReducer(s, { type: 'toggle-lock', seq: 102 })
    return s
  }

  const BATCH_EVENTS = [
    ev('b105', 105, 1, '新增片段'), // 新增
    ev('b101v2', 101, 2, '101改写', 'revision'), // 改写
    ev('b102v2', 102, 2, '102机器修订', 'revision'), // 锁定冲突
    ev('b103v1x', 103, 1, '103同版本不同内容'), // 同版本矛盾 => 过期
    ev('b104dup', 104, 1, '完全相同', 'revision'), // 同版本同内容 => 无变化
  ]

  it('一次补发生成稳定批次，正确区分新增/改写/冲突/无变化/过期', () => {
    const s = consoleReducer(baseState(), openBatch('b-1', BATCH_EVENTS))
    expect(s.activeBatch).not.toBeNull()
    expect(s.activeBatch!.id).toBe('b-1')

    expect(itemOf(s, 105).kind).toBe('added')
    expect(itemOf(s, 101).kind).toBe('revised')
    expect(itemOf(s, 102).kind).toBe('conflict')
    expect(itemOf(s, 103).kind).toBe('stale')
    expect(itemOf(s, 104).kind).toBe('unchanged')

    // 到达事件流记录分类统计
    expect(s.log.some((l) => l.kind === 'batch' && l.message.includes('新增 1'))).toBe(true)
  })

  it('人工锁定内容默认排除，只有新增/改写默认可选且不自动勾选', () => {
    const s = consoleReducer(baseState(), openBatch('b-1', BATCH_EVENTS))
    expect(itemOf(s, 102).locked).toBe(true)
    expect(itemOf(s, 102).selected).toBe(false)

    // 默认没有任何条目被勾选，需运营显式选择
    expect(s.activeBatch!.items.filter((i) => i.selected)).toHaveLength(0)
    // 冲突/无变化/过期不可勾选
    for (const seq of [102, 103, 104]) {
      const toggled = consoleReducer(s, { type: 'batch-toggle-item', seq, selected: true })
      expect(itemOf(toggled, seq).selected).toBe(false)
    }
    // 新增/改写可以勾选
    const selected = consoleReducer(s, { type: 'batch-toggle-item', seq: 105, selected: true })
    expect(itemOf(selected, 105).selected).toBe(true)
  })

  it('批次打开期间时间线不发生任何静默变化', () => {
    const before = baseState()
    const after = consoleReducer(before, openBatch('b-1', BATCH_EVENTS))
    expect(after.segments).toEqual(before.segments)
    expect(after.seenEventIds).toEqual(before.seenEventIds)
    expect(after.conflicts).toEqual(before.conflicts)
  })
})

describe('锁定冲突条目', () => {
  function lockedState(): ConsoleState {
    let s = feed(createInitialState(), [ev('e201', 201, 1, '锁定原文')])
    s = consoleReducer(s, { type: 'edit', seq: 201, text: '锁定人工稿' })
    s = consoleReducer(s, { type: 'toggle-lock', seq: 201 })
    return s
  }

  it('明确解锁后冲突条目才能进入批次并默认勾选，重新锁定再次排除', () => {
    let s = consoleReducer(
      lockedState(),
      openBatch('b-lock', [ev('b201v2', 201, 2, '机器新稿', 'revision')]),
    )
    expect(itemOf(s, 201).kind).toBe('conflict')
    expect(itemOf(s, 201).selected).toBe(false)

    // 解锁：显式意愿，条目变为改写并勾选
    s = consoleReducer(s, { type: 'toggle-lock', seq: 201 })
    expect(itemOf(s, 201).kind).toBe('revised')
    expect(itemOf(s, 201).locked).toBe(false)
    expect(itemOf(s, 201).selected).toBe(true)

    // 重新锁定：条目再次被排除，勾选清除
    s = consoleReducer(s, { type: 'toggle-lock', seq: 201 })
    expect(itemOf(s, 201).kind).toBe('conflict')
    expect(itemOf(s, 201).selected).toBe(false)
  })

  it('解锁后接受批次：应用机器内容，人工锁定状态保留（不被批次悄悄解锁）', () => {
    let s = consoleReducer(
      lockedState(),
      openBatch('b-lock', [ev('b201v2', 201, 2, '机器新稿', 'revision')]),
    )
    s = consoleReducer(s, { type: 'toggle-lock', seq: 201 })
    s = consoleReducer(s, { type: 'batch-accept' })

    expect(s.activeBatch).toBeNull()
    expect(s.segments[201]).toMatchObject({
      text: '机器新稿',
      version: 2,
      origin: 'machine',
    })
    // 解锁只是为了放行本批，接受后仍按用户最后一次锁定操作的状态保持解锁
    expect(s.segments[201].locked).toBe(false)
  })
})

describe('部分接受与整批接受', () => {
  function stateWithBatch(): ConsoleState {
    const base = feed(createInitialState(), [
      ev('e301', 301, 1, 'A旧'),
      ev('e302', 302, 1, 'B旧'),
    ])
    return consoleReducer(
      base,
      openBatch('b-part', [
        ev('b301v2', 301, 2, 'A新', 'revision'),
        ev('b302v2', 302, 2, 'B新', 'revision'),
        ev('b303v1', 303, 1, 'C新增'),
      ]),
    )
  }

  it('只接受勾选条目，其余继续留在批次中复核', () => {
    let s = stateWithBatch()
    s = consoleReducer(s, { type: 'batch-select-all', selected: true })
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 302, selected: false })
    s = consoleReducer(s, { type: 'batch-accept' })

    // #301、#303 已应用
    expect(s.segments[301].text).toBe('A新')
    expect(s.segments[303].text).toBe('C新增')
    // #302 仍是旧内容
    expect(s.segments[302].text).toBe('B旧')

    // 批次仍在，只剩 #302，且保留勾选意愿为未选
    expect(s.activeBatch).not.toBeNull()
    expect(s.activeBatch!.items.map((i) => i.seq)).toEqual([302])
    expect(itemOf(s, 302).selected).toBe(false)
    expect(s.activeBatch!.appliedEventIds).toEqual(['b301v2', 'b303v1'])

    // 第二次接受剩余条目，批次结束并归档
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 302, selected: true })
    s = consoleReducer(s, { type: 'batch-accept' })
    expect(s.activeBatch).toBeNull()
    expect(s.closedBatchIds).toContain('b-part')
    expect(s.segments[302].text).toBe('B新')
  })

  it('没有勾选时接受不产生任何变化', () => {
    const s0 = stateWithBatch()
    const s1 = consoleReducer(s0, { type: 'batch-accept' })
    expect(s1).toBe(s0)
  })
})

describe('重复批次不重复应用', () => {
  it('批次关闭后同一稳定 ID 再次补发被判重', () => {
    let s = feed(createInitialState(), [ev('e401', 401, 1, '旧')])
    s = consoleReducer(s, openBatch('b-dup', [ev('b401v2', 401, 2, '新', 'revision')]))
    s = consoleReducer(s, { type: 'batch-select-all', selected: true })
    s = consoleReducer(s, { type: 'batch-accept' })
    expect(s.activeBatch).toBeNull()
    expect(s.segments[401].text).toBe('新')

    // 同 ID 批次再次补发：判重日志，不重新打开
    const again = consoleReducer(s, openBatch('b-dup', [ev('b401v2', 401, 2, '新', 'revision')]))
    expect(again.activeBatch).toBeNull()
    expect(again.segments).toEqual(s.segments)
    expect(again.log.some((l) => l.kind === 'duplicate' && l.message.includes('重复批次'))).toBe(true)
  })

  it('复核途中同一批次重复补发不会重置已做的勾选', () => {
    let s = feed(createInitialState(), [ev('e501', 501, 1, '旧')])
    const batchEvents = [ev('b501v2', 501, 2, '新', 'revision')]
    s = consoleReducer(s, openBatch('b-live', batchEvents))
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 501, selected: true })
    const again = consoleReducer(s, openBatch('b-live', batchEvents, 15000))
    expect(again.activeBatch).toBe(s.activeBatch)
    expect(itemOf(again, 501).selected).toBe(true)
  })

  it('已接受的批次事件进入事件去重表，晚到重发不重复落库', () => {
    let s = feed(createInitialState(), [ev('e601', 601, 1, '旧')])
    s = consoleReducer(s, openBatch('b-seen', [ev('b601v2', 601, 2, '新', 'revision')]))
    s = consoleReducer(s, { type: 'batch-select-all', selected: true })
    s = consoleReducer(s, { type: 'batch-accept' })

    // 同一事件 ID 走单事件通道晚到：事件级去重
    const late = consoleReducer(s, ingest(ev('b601v2', 601, 2, '新', 'revision'), 20000))
    expect(late.segments[601]).toEqual(s.segments[601])
    expect(late.log.some((l) => l.kind === 'duplicate' && l.seq === 601)).toBe(true)
  })
})

describe('晚到片段在复核期间到达', () => {
  it('批次新增条目被机器晚到补齐后，该条变为无变化，接受时不重复新增', () => {
    let s = createInitialState()
    s = consoleReducer(
      s,
      openBatch('b-late', [
        ev('b701', 701, 1, '已有'),
        ev('b702', 702, 1, '晚到新增'),
      ]),
    )
    expect(itemOf(s, 702).kind).toBe('added')

    // #702 通过普通事件通道晚到，直接落库
    s = consoleReducer(s, ingest(ev('e702-late', 702, 1, '晚到新增'), 13000))
    expect(s.segments[702].text).toBe('晚到新增')

    // 批次过期并重算：#702 变无变化，旧勾选清空
    expect(s.activeBatch!.stale).toBe(true)
    expect(itemOf(s, 702).kind).toBe('unchanged')
    expect(s.activeBatch!.items.some((i) => i.selected)).toBe(false)

    // 确认重算后只接受 #701；#702 不会被重复写第二遍
    s = consoleReducer(s, { type: 'batch-recalculate' })
    expect(s.activeBatch!.stale).toBe(false)
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 701, selected: true })
    s = consoleReducer(s, { type: 'batch-accept' })
    expect(s.segments[702].text).toBe('晚到新增')
    expect(Object.keys(s.segments).map(Number).sort()).toEqual([701, 702])
  })
})

describe('复核期间更新导致过期重算', () => {
  it('批次过期时禁止接受，重算后采用最新内容，绝不套用旧选择', () => {
    let s = feed(createInitialState(), [ev('e801', 801, 1, '旧稿')])
    s = consoleReducer(s, openBatch('b-stale', [ev('b801v2', 801, 2, '批次稿v2', 'revision')]))
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 801, selected: true })

    // 复核期间机器又推来 v3
    s = consoleReducer(s, ingest(ev('e801v3', 801, 3, '直播最新v3', 'revision'), 14000))
    expect(s.segments[801].text).toBe('直播最新v3')
    expect(s.activeBatch!.stale).toBe(true)
    // 旧勾选已清空
    expect(itemOf(s, 801).selected).toBe(false)
    // 条目按最新时间线重算：批次 v2 已过期
    expect(itemOf(s, 801).kind).toBe('stale')

    // 过期状态下整批接受被拦截
    const blocked = consoleReducer(s, { type: 'batch-accept' })
    expect(blocked).toBe(s)

    // 确认重算后批次条目仍然过期（v2 不新于当前 v3），无法再接受旧内容
    s = consoleReducer(s, { type: 'batch-recalculate' })
    expect(itemOf(s, 801).kind).toBe('stale')
    expect(s.segments[801].text).toBe('直播最新v3')
  })

  it('机器更新与批次同版本时，重算为无变化，旧选择不会被应用', () => {
    let s = feed(createInitialState(), [ev('e901', 901, 1, '旧')])
    s = consoleReducer(s, openBatch('b-eq', [ev('b901v2', 901, 2, '修订稿', 'revision')]))
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 901, selected: true })

    // 另一条通道以不同事件 ID 应用了相同版本与内容
    s = consoleReducer(s, ingest(ev('e901v2-other', 901, 2, '修订稿', 'revision'), 14000))
    expect(s.activeBatch!.stale).toBe(true)
    expect(itemOf(s, 901).kind).toBe('unchanged')
    expect(itemOf(s, 901).selected).toBe(false)
  })
})

describe('撤销与重做', () => {
  it('撤销部分接受后时间线与批次恢复，重做再次应用', () => {
    let s = feed(createInitialState(), [ev('eA', 1, 1, '旧1'), ev('eB', 2, 1, '旧2')])
    s = consoleReducer(
      s,
      openBatch('b-u', [
        ev('bA2', 1, 2, '新1', 'revision'),
        ev('bB2', 2, 2, '新2', 'revision'),
      ]),
    )
    s = consoleReducer(s, { type: 'batch-select-all', selected: true })
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 2, selected: false })
    const before = s
    s = consoleReducer(s, { type: 'batch-accept' })
    expect(s.segments[1].text).toBe('新1')
    expect(s.segments[2].text).toBe('旧2')

    // 撤销：#1 回退，批次与勾选恢复
    s = consoleReducer(s, { type: 'undo' })
    expect(s.segments[1].text).toBe('旧1')
    expect(s.activeBatch).not.toBeNull()
    expect(itemOf(s, 1).selected).toBe(true)
    expect(itemOf(s, 2).selected).toBe(false)
    expect(s.activeBatch!.appliedEventIds).toEqual([])

    // 重做：#1 再次应用
    s = consoleReducer(s, { type: 'redo' })
    expect(s.segments[1].text).toBe('新1')
    expect(s.activeBatch!.appliedEventIds).toEqual(['bA2'])

    // 撤销两次（接受 #1、再接受 #2）逐步回退
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 2, selected: true })
    s = consoleReducer(s, { type: 'batch-accept' })
    expect(s.activeBatch).toBeNull()
    s = consoleReducer(s, { type: 'undo' })
    expect(s.activeBatch).not.toBeNull()
    expect(s.segments[2].text).toBe('旧2')
    s = consoleReducer(s, { type: 'undo' })
    expect(s.segments[1].text).toBe('旧1')
    expect(before.log.length).toBeGreaterThan(0)
  })

  it('关闭批次可撤销，撤销后重新出现且重复补发仍判重', () => {
    let s = feed(createInitialState(), [ev('eC', 1, 1, '旧')])
    s = consoleReducer(s, openBatch('b-c', [ev('bC2', 1, 2, '新', 'revision')]))
    s = consoleReducer(s, { type: 'batch-close' })
    expect(s.activeBatch).toBeNull()
    expect(s.closedBatchIds).toContain('b-c')

    s = consoleReducer(s, { type: 'undo' })
    expect(s.activeBatch?.id).toBe('b-c')
    expect(s.closedBatchIds).not.toContain('b-c')
  })

  it('没有历史时撤销/重做是空操作', () => {
    const s0 = createInitialState()
    expect(consoleReducer(s0, { type: 'undo' })).toBe(s0)
    expect(consoleReducer(s0, { type: 'redo' })).toBe(s0)
  })
})

describe('刷新恢复', () => {
  it('进行中的批次、勾选与撤销栈完整恢复，并可继续操作', () => {
    installMemoryStorage()
    let s = feed(createInitialState(), [ev('eR', 1, 1, '旧')])
    s = consoleReducer(s, openBatch('b-r', [ev('bR2', 1, 2, '新', 'revision')]))
    s = consoleReducer(s, { type: 'batch-toggle-item', seq: 1, selected: true })

    // 模拟刷新：写入再读出
    saveState(s)
    const restored = loadState()
    expect(restored.activeBatch?.id).toBe('b-r')
    expect(restored.activeBatch!.items[0]).toMatchObject({ seq: 1, selected: true, kind: 'revised' })
    expect(restored.segments[1].text).toBe('旧')

    // 恢复后继续接受，行为与刷新前完全一致
    const accepted = consoleReducer(restored, { type: 'batch-accept' })
    expect(accepted.segments[1].text).toBe('新')
    expect(accepted.activeBatch).toBeNull()
  })

  it('存档损坏或缺省时安全回到初始状态', () => {
    installMemoryStorage()
    expect(loadState()).toEqual(createInitialState())
    localStorage.setItem('subtitle-qc-console:v1', '{不是合法 JSON')
    expect(loadState()).toEqual(createInitialState())
    localStorage.setItem('subtitle-qc-console:v1', JSON.stringify({ segments: null }))
    expect(loadState()).toEqual(createInitialState())
  })

  it('重置后无批次残留', () => {
    let s = feed(createInitialState(), [ev('eZ', 1, 1, 'x')])
    s = consoleReducer(s, openBatch('b-z', [ev('bZ2', 1, 2, 'y', 'revision')]))
    s = consoleReducer(s, { type: 'batch-select-all', selected: true })
    s = consoleReducer(s, { type: 'batch-accept' })
    expect(s.closedBatchIds).toHaveLength(1)
    expect(consoleReducer(s, { type: 'reset' })).toEqual(createInitialState())
  })
})
