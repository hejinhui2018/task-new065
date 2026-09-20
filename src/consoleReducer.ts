import {
  computeItems,
  isSelectableItem,
  normalizeBatchEvents,
  recomputeBatch,
  selectionMap,
  summarizeItems,
} from './batch'
import type {
  Conflict,
  ConsoleState,
  HistoryEntry,
  LogKind,
  SubtitleEvent,
  SubtitleSegment,
} from './types'

/**
 * 控制台状态机：纯函数，不读时钟、不含随机性。
 * 相同的初始状态 + 相同的动作序列 => 完全相同的结果（可稳定重放）。
 */

export type ConsoleAction =
  | { type: 'ingest'; event: SubtitleEvent; receivedAt: number | null }
  | { type: 'edit'; seq: number; text: string }
  | { type: 'toggle-lock'; seq: number }
  | { type: 'resolve-conflict'; seq: number; choice: 'keep' | 'accept' }
  | { type: 'batch-open'; id: string; label: string; events: SubtitleEvent[]; at: number | null }
  | { type: 'batch-toggle-item'; seq: number; selected: boolean }
  | { type: 'batch-select-all'; selected: boolean }
  | { type: 'batch-recalculate' }
  | { type: 'batch-accept' }
  | { type: 'batch-close' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset' }

export function createInitialState(): ConsoleState {
  return {
    segments: {},
    seenEventIds: {},
    conflicts: [],
    log: [],
    nextLogId: 1,
    activeBatch: null,
    closedBatchIds: [],
    past: [],
    future: [],
  }
}

/** 事件流最多保留的条数，防止长时间运行无限增长 */
const MAX_LOG_ENTRIES = 200
/** 撤销栈深度 */
const MAX_HISTORY = 50

function withLog(
  state: ConsoleState,
  kind: LogKind,
  seq: number | null,
  at: number | null,
  message: string,
): ConsoleState {
  const entry = { id: state.nextLogId, kind, seq, at, message }
  return {
    ...state,
    log: [...state.log, entry].slice(-MAX_LOG_ENTRIES),
    nextLogId: state.nextLogId + 1,
  }
}

/** 把当前状态压入撤销栈（在产生变更前调用），并清空重做栈 */
function commit(state: ConsoleState, next: ConsoleState, label: string): ConsoleState {
  const entry: HistoryEntry = { state: stripHistory(state), label }
  return {
    ...next,
    past: [...state.past, entry].slice(-MAX_HISTORY),
    future: [],
  }
}

/** 快照只保存领域状态与日志，不携带历史栈，避免撤销链嵌套膨胀 */
function stripHistory(state: ConsoleState): ConsoleState {
  return { ...state, past: [], future: [] }
}

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'reset':
      // 重放必须回到一尘不染的初始状态，不留任何上一轮的痕迹
      return createInitialState()

    case 'undo':
      return undo(state, false)

    case 'redo':
      return undo(state, true)

    case 'ingest':
      return ingest(state, action.event, action.receivedAt)

    case 'edit': {
      const seg = state.segments[action.seq]
      if (!seg || seg.locked) return state // 锁定片段不可直接编辑，需先解锁
      const text = action.text.trim()
      if (!text || text === seg.text) return state
      const next: SubtitleSegment = { ...seg, text, origin: 'manual' }
      let s: ConsoleState = { ...state, segments: { ...state.segments, [action.seq]: next } }
      s = withLog(s, 'manual', action.seq, null, `人工修改 #${action.seq}：「${text}」`)
      // 人工修改后批次候选随之重算（保留此前勾选）
      s = recomputeBatch(s)
      return commit(state, s, `人工修改 #${action.seq}`)
    }

    case 'toggle-lock': {
      const seg = state.segments[action.seq]
      if (!seg) return state
      const locked = !seg.locked
      let s: ConsoleState = {
        ...state,
        segments: { ...state.segments, [action.seq]: { ...seg, locked } },
      }
      s = withLog(
        s,
        'lock',
        action.seq,
        null,
        locked
          ? `已锁定 #${action.seq}，后续机器修订将转入人工裁决`
          : `已解锁 #${action.seq}，机器修订将直接应用`,
      )
      // 明确解锁后：若该序号在复核批次中是冲突条目，立即具备进入批次的资格并勾选
      s = recomputeBatch(s, locked ? undefined : { forceSelected: new Set([action.seq]) })
      return commit(state, s, locked ? `锁定 #${action.seq}` : `解锁 #${action.seq}`)
    }

    case 'resolve-conflict': {
      const conflict = state.conflicts.find((c) => c.seq === action.seq)
      if (!conflict) return state
      const seg = state.segments[action.seq]
      const conflicts = state.conflicts.filter((c) => c.seq !== action.seq)
      let s: ConsoleState
      if (action.choice === 'keep') {
        // 保留人工版本：片段原样不动，仅丢弃这条机器修订
        s = { ...state, conflicts }
        s = withLog(
          s,
          'resolved',
          action.seq,
          null,
          `保留人工版本，忽略机器修订 v${conflict.incomingVersion}（#${action.seq}）`,
        )
      } else {
        // 接受机器版本：应用新内容并解除锁定，片段交还给机器流
        if (!seg) return state
        const next: SubtitleSegment = {
          ...seg,
          text: conflict.incomingText,
          version: conflict.incomingVersion,
          origin: 'machine',
          locked: false,
        }
        s = { ...state, conflicts, segments: { ...state.segments, [action.seq]: next } }
        s = withLog(
          s,
          'resolved',
          action.seq,
          null,
          `接受机器修订 v${conflict.incomingVersion}（#${action.seq}），片段解除锁定`,
        )
      }
      s = recomputeBatch(s)
      return commit(state, s, `裁决冲突 #${action.seq}`)
    }

    /* ---------------- 批次复核 ---------------- */

    case 'batch-open':
      return openBatch(state, action.id, action.label, action.events, action.at)

    case 'batch-toggle-item': {
      const batch = state.activeBatch
      if (!batch) return state
      const items = batch.items.map((item) => {
        if (item.seq !== action.seq) return item
        if (!isSelectableItem(item)) return item // 锁定/无变化/过期条目不可勾选
        return { ...item, selected: action.selected }
      })
      return { ...state, activeBatch: { ...batch, items } }
    }

    case 'batch-select-all': {
      const batch = state.activeBatch
      if (!batch) return state
      const items = batch.items.map((item) =>
        isSelectableItem(item) ? { ...item, selected: action.selected } : item,
      )
      return { ...state, activeBatch: { ...batch, items } }
    }

    case 'batch-recalculate': {
      const batch = state.activeBatch
      if (!batch || !batch.stale) return state
      // 条目已在更新到达时按新时间线重算，这里仅清过期标记并记录审计
      let s: ConsoleState = { ...state, activeBatch: { ...batch, stale: false } }
      s = withLog(
        s,
        'batch',
        null,
        null,
        `批次「${batch.label}」已按最新时间线重新计算，请重新确认要接受的条目`,
      )
      return s
    }

    case 'batch-accept':
      // 批次已过期时禁止静默套用，必须先重新计算确认
      if (state.activeBatch?.stale) return state
      return acceptBatch(state)

    case 'batch-close': {
      const batch = state.activeBatch
      if (!batch) return state
      let s: ConsoleState = {
        ...state,
        activeBatch: null,
        closedBatchIds: [...state.closedBatchIds, batch.id],
      }
      s = withLog(
        s,
        'batch',
        null,
        null,
        `批次「${batch.label}」已关闭，未接受的 ${batch.items.length} 条候选未应用`,
      )
      return commit(state, s, `关闭批次「${batch.label}」`)
    }
  }
}

function undo(state: ConsoleState, redo: boolean): ConsoleState {
  if (redo) {
    if (state.future.length === 0) return state
    const entry = state.future[state.future.length - 1]
    const restFuture = state.future.slice(0, -1)
    // 重做：恢复目标快照，把当前状态压回撤销栈
    const target: ConsoleState = {
      ...entry.state,
      past: [...state.past, { state: stripHistory(state), label: entry.label }],
      future: restFuture,
    }
    return withLog(
      withMonotonicLogId(target, state),
      'history',
      null,
      null,
      `重做：${entry.label}`,
    )
  }
  if (state.past.length === 0) return state
  const entry = state.past[state.past.length - 1]
  const restPast = state.past.slice(0, -1)
  // 撤销：恢复旧快照，把当前状态压入重做栈
  const target: ConsoleState = {
    ...entry.state,
    past: restPast,
    future: [...state.future, { state: stripHistory(state), label: entry.label }],
  }
  return withLog(
    withMonotonicLogId(target, state),
    'history',
    null,
    null,
    `撤销：${entry.label}`,
  )
}

/** 恢复的快照可能带有更早的日志序号，统一抬到不小于当前序号，避免日志 id 撞车 */
function withMonotonicLogId(target: ConsoleState, current: ConsoleState): ConsoleState {
  return target.nextLogId >= current.nextLogId
    ? target
    : { ...target, nextLogId: current.nextLogId }
}

function openBatch(
  state: ConsoleState,
  id: string,
  label: string,
  events: SubtitleEvent[],
  at: number | null,
): ConsoleState {
  // 同一批次重复到达（仍在复核中或已关闭）：绝不重复开启/应用
  if (state.activeBatch?.id === id || state.closedBatchIds.includes(id)) {
    return withLog(
      state,
      'duplicate',
      null,
      at,
      `重复批次 ${id}（${events.length} 条）已忽略，未重复应用`,
    )
  }
  // 另一个批次仍在复核：旧批次按关闭归档，避免静默丢失或重复应用
  if (state.activeBatch) {
    const previous = state.activeBatch
    state = {
      ...state,
      activeBatch: null,
      closedBatchIds: [...state.closedBatchIds, previous.id],
    }
    state = withLog(
      state,
      'batch',
      null,
      at,
      `批次「${previous.label}」被新补发批次取代，未接受项按关闭处理`,
    )
  }
  const normalized = normalizeBatchEvents(events)
  const items = computeItems(normalized, state.segments)
  const summary = summarizeItems(items)
  let s: ConsoleState = {
    ...state,
    activeBatch: {
      id,
      label,
      openedAt: at,
      events: normalized,
      items,
      stale: false,
      appliedEventIds: [],
    },
  }
  s = withLog(
    s,
    'batch',
    null,
    at,
    `批次「${label}」到达：新增 ${summary.added}、改写 ${summary.revised}、冲突 ${summary.conflict}、无变化 ${summary.unchanged}，等待批次复核`,
  )
  return s
}

function acceptBatch(state: ConsoleState): ConsoleState {
  const batch = state.activeBatch
  if (!batch) return state
  // 以当前条目为准（所有更新都会先触发重算），只应用仍可选且被勾选的条目
  const targets = batch.items.filter((item) => item.selected && isSelectableItem(item))
  if (targets.length === 0) return state

  let segments = { ...state.segments }
  const seenEventIds = { ...state.seenEventIds }
  let conflicts = state.conflicts
  for (const item of targets) {
    seenEventIds[item.eventId] = true
    // 被接受的修订所涉序号，旧的待裁决冲突同时失效
    conflicts = conflicts.filter((c) => c.seq !== item.seq)
    const existing = segments[item.seq]
    segments[item.seq] = {
      seq: item.seq,
      text: item.incomingText,
      version: item.incomingVersion,
      origin: 'machine',
      locked: existing?.locked ?? false,
    }
  }

  const appliedEventIds = [...batch.appliedEventIds, ...targets.map((item) => item.eventId)]
  // 应用后用新时间线重算剩余候选；已应用条目自动消失，其余勾选保留
  const items = computeItems(batch.events, segments, {
    prevSelection: selectionMap(batch.items),
    appliedEventIds: new Set(appliedEventIds),
  })
  // 仍需人工处理的只有新增/改写/冲突；无变化与过期仅作展示，不再阻塞批次结束
  const actionable = items.filter(
    (item) => item.kind === 'added' || item.kind === 'revised' || item.kind === 'conflict',
  ).length
  const finished = actionable === 0
  const seqsText = targets.map((item) => `#${item.seq}`).join('、')

  let s: ConsoleState = {
    ...state,
    segments,
    seenEventIds,
    conflicts,
    activeBatch: finished ? null : { ...batch, items, appliedEventIds, stale: false },
    closedBatchIds: finished ? [...state.closedBatchIds, batch.id] : state.closedBatchIds,
  }
  s = withLog(
    s,
    'batch',
    null,
    batch.openedAt,
    finished
      ? `批次「${batch.label}」复核完成（本次接受 ${seqsText}），批次关闭`
      : `批次「${batch.label}」已接受 ${targets.length} 条（${seqsText}），剩余 ${actionable} 条继续复核`,
  )
  return commit(state, s, `接受批次 ${targets.length} 条`)
}

function ingest(
  state: ConsoleState,
  event: SubtitleEvent,
  receivedAt: number | null,
): ConsoleState {
  // 1) 事件级去重：同一事件 ID 只处理一次
  if (state.seenEventIds[event.id]) {
    return withLog(
      state,
      'duplicate',
      event.seq,
      receivedAt,
      `重复事件 ${event.id}（#${event.seq} v${event.version}）已忽略，未生成新字幕`,
    )
  }
  const seenEventIds = { ...state.seenEventIds, [event.id]: true as const }
  const existing = state.segments[event.seq]

  // 2) 全新片段：直接落位；若序号小于已收到的最大序号，说明是晚到补齐
  if (!existing) {
    const seg: SubtitleSegment = {
      seq: event.seq,
      text: event.text,
      version: event.version,
      origin: 'machine',
      locked: false,
    }
    const keys = Object.keys(state.segments)
    const maxSeq = keys.length > 0 ? Math.max(...keys.map(Number)) : null
    const isBackfill = maxSeq !== null && event.seq < maxSeq
    let s: ConsoleState = {
      ...state,
      seenEventIds,
      segments: { ...state.segments, [event.seq]: seg },
    }
    s = withLog(s, 'received', event.seq, receivedAt, `接收 #${event.seq} v${event.version}：「${event.text}」`)
    if (isBackfill) {
      s = withLog(s, 'backfilled', event.seq, receivedAt, `晚到片段 #${event.seq} 已自动补回缺口`)
    }
    return touchBatchAfterIngest(state, s, receivedAt)
  }

  const s0: ConsoleState = { ...state, seenEventIds }

  // 3) 已有片段：按版本号裁决
  if (event.version < existing.version) {
    return withLog(
      s0,
      'stale',
      event.seq,
      receivedAt,
      `过期版本 v${event.version}（当前 v${existing.version}）已忽略（#${event.seq}）`,
    )
  }
  if (event.version === existing.version) {
    if (event.text === existing.text) {
      // 内容级去重：不同事件 ID 但内容完全相同
      return withLog(s0, 'duplicate', event.seq, receivedAt, `重复内容 #${event.seq} v${event.version}，已忽略`)
    }
    return withLog(
      s0,
      'stale',
      event.seq,
      receivedAt,
      `同版本 v${event.version} 内容不一致，保留现有内容（#${event.seq}）`,
    )
  }

  // 4) 更新的机器版本
  if (existing.locked) {
    // 锁定片段：绝不静默覆盖，登记冲突等待人工裁决（同一片段只保留最新一条待裁决）
    const conflict: Conflict = {
      seq: event.seq,
      manualText: existing.text,
      manualVersion: existing.version,
      incomingText: event.text,
      incomingVersion: event.version,
      receivedAt,
    }
    const conflicts = [...state.conflicts.filter((c) => c.seq !== event.seq), conflict]
    let s: ConsoleState = { ...s0, conflicts }
    s = withLog(
      s,
      'conflict',
      event.seq,
      receivedAt,
      `#${event.seq} 已锁定，机器修订 v${event.version} 未覆盖人工内容，转入人工裁决`,
    )
    // 冲突登记不改时间线内容，但锁定状态下批次条目本就被拦截，无需标记过期
    return s
  }

  // 未锁定：直接应用修订；若该片段曾有悬而未决的冲突，旧冲突随之失效
  const hadManualText = existing.origin === 'manual'
  const droppedConflict = state.conflicts.some((c) => c.seq === event.seq)
  const conflicts = state.conflicts.filter((c) => c.seq !== event.seq)
  const next: SubtitleSegment = {
    ...existing,
    text: event.text,
    version: event.version,
    origin: 'machine',
  }
  let s: ConsoleState = { ...s0, conflicts, segments: { ...state.segments, [event.seq]: next } }
  const notes = [
    hadManualText ? '覆盖了未锁定的人工修改' : '',
    droppedConflict ? '旧的待裁决冲突已失效' : '',
  ]
    .filter(Boolean)
    .join('，')
  s = withLog(
    s,
    'revised',
    event.seq,
    receivedAt,
    `机器修订 v${event.version} 已应用（#${event.seq}）${notes ? `，${notes}` : ''}`,
  )
  return touchBatchAfterIngest(state, s, receivedAt)
}

/**
 * 复核进行中时间线又被机器更新：
 * 批次标记为已过期，按最新时间线重新计算，并丢弃旧勾选（不能静默套用旧选择）。
 */
function touchBatchAfterIngest(
  prev: ConsoleState,
  next: ConsoleState,
  receivedAt: number | null,
): ConsoleState {
  const batch = prev.activeBatch
  if (!batch || next.segments === prev.segments) return next
  let s = recomputeBatch(next, { resetSelection: true })
  const active = s.activeBatch!
  if (active.stale) return s // 已在过期状态，不重复刷日志
  s = { ...s, activeBatch: { ...active, stale: true } }
  s = withLog(
    s,
    'batch',
    null,
    receivedAt,
    `批次「${batch.label}」复核期间时间线发生变化，批次已过期并重新计算，旧选择已清空`,
  )
  return s
}
