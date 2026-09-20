import { acceptableSeqs, classifyEntry, mergeEntry, reconcileSelection } from './batch'
import type {
  BatchHistoryStep,
  Conflict,
  ConsoleState,
  LogKind,
  ReviewBatch,
  SubtitleEvent,
  SubtitleSegment,
} from './types'

/**
 * 控制台状态机：纯函数，不读时钟、不含随机性。
 * 相同的初始状态 + 相同的动作序列 => 完全相同的结果（可稳定重放）。
 */

export type BatchAcceptMode = 'selected' | 'all' | 'finish'

export type ConsoleAction =
  | { type: 'ingest'; event: SubtitleEvent; receivedAt: number | null }
  | { type: 'batch-begin'; id: string; at: number | null }
  | { type: 'batch-end'; id: string; at: number | null }
  | { type: 'batch-toggle'; seq: number }
  | { type: 'batch-select-all'; selected: boolean }
  /** selected=接受勾选并继续复核；all=整批接受；finish=接受勾选并把其余全部排除、结束复核 */
  | { type: 'batch-accept'; mode: BatchAcceptMode }
  | { type: 'batch-undo' }
  | { type: 'batch-redo' }
  | { type: 'batch-archive'; batchId: string }
  | { type: 'edit'; seq: number; text: string }
  | { type: 'toggle-lock'; seq: number }
  | { type: 'resolve-conflict'; seq: number; choice: 'keep' | 'accept' }
  | { type: 'hydrate'; state: ConsoleState }
  | { type: 'reset' }

export function createInitialState(): ConsoleState {
  return {
    segments: {},
    seenEventIds: {},
    conflicts: [],
    log: [],
    nextLogId: 1,
    currentBatch: null,
    batchHistory: [],
    undoStack: [],
    redoStack: [],
  }
}

/** 事件流最多保留的条数，防止长时间运行无限增长 */
const MAX_LOG_ENTRIES = 200
/** 已完成批次最多保留的审计条数 */
const MAX_BATCH_HISTORY = 10

interface LogSpec {
  kind: LogKind
  seq: number | null
  at: number | null
  message: string
}

function withLog(state: ConsoleState, kind: LogKind, seq: number | null, at: number | null, message: string): ConsoleState {
  return logMany(state, [{ kind, seq, at, message }])
}

function logMany(state: ConsoleState, entries: LogSpec[]): ConsoleState {
  if (entries.length === 0) return state
  const nextLog = entries.map((e, i) => ({ id: state.nextLogId + i, ...e }))
  return {
    ...state,
    log: [...state.log, ...nextLog].slice(-MAX_LOG_ENTRIES),
    nextLogId: state.nextLogId + entries.length,
  }
}

/** 批次复核期间人工改动时间线后，按最新分类刷新勾选（只移除、不新增） */
function pruneSelection(state: ConsoleState): ConsoleState {
  const batch = state.currentBatch
  if (!batch || batch.phase !== 'pending') return state
  const eligible = new Set(acceptableSeqs(batch, state))
  const selected = batch.selected.filter((seq) => eligible.has(seq))
  if (selected.length === batch.selected.length) return state
  return { ...state, currentBatch: { ...batch, selected } }
}

/** 从当前批次勾选里移除指定 seq（人工明确改动后，机器版本不再替其勾选） */
function removeSelection(state: ConsoleState, seq: number): ConsoleState {
  const batch = state.currentBatch
  if (!batch || batch.phase !== 'pending' || !batch.selected.includes(seq)) return state
  return {
    ...state,
    currentBatch: { ...batch, selected: batch.selected.filter((s) => s !== seq) },
  }
}

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'reset':
      // 重放必须回到一尘不染的初始状态，不留任何上一轮的痕迹
      return createInitialState()

    case 'hydrate':
      // 刷新恢复：直接采用通过校验的持久化状态
      return action.state

    case 'ingest': {
      // 仅与当前批次相关（事件携带相同 batchId）的事件进入批次缓冲；
      // 其余事件走常规通道，批次绝不吞噬无关的直播流。
      if (state.currentBatch && action.event.batchId === state.currentBatch.id) {
        return ingestIntoBatch(state, action.event, action.receivedAt)
      }
      return ingestDirect(state, action.event, action.receivedAt)
    }

    case 'batch-begin': {
      if (state.currentBatch) return state // 同组 begin 重发幂等；复核未结束时不许抢占
      // 同 ID 批次已复核完成：整批重发。事件本身会被 seenEventIds 去重，
      // 这里连空批次也不再开，只留审计日志。
      if (state.batchHistory.some((b) => b.id === action.id)) {
        return withLog(
          state,
          'duplicate',
          null,
          action.at,
          `补发批次 ${action.id} 重复到达：该批次已复核完成，整批重发已忽略，不会重复应用`,
        )
      }
      const batch: ReviewBatch = {
        id: action.id,
        phase: 'open',
        entries: {},
        selected: [],
        openedAt: null,
        staleSince: null,
        staleCount: 0,
        accepted: [],
        appliedCount: 0,
        excludedCount: 0,
      }
      // 新批次开始：上一批次的撤销/重做路径随之关闭，
      // 防止在新批次复核时误撤销旧批次、把新批次冲掉
      let s: ConsoleState = { ...state, currentBatch: batch, undoStack: [], redoStack: [] }
      s = withLog(
        s,
        'batch',
        null,
        action.at,
        `补发批次 ${action.id} 开始收集，修订将暂缓套用、整批等待复核`,
      )
      return s
    }

    case 'batch-end': {
      const batch = state.currentBatch
      if (!batch || batch.id !== action.id || batch.phase !== 'open') return state
      const pending: ReviewBatch = {
        ...batch,
        phase: 'pending',
        openedAt: action.at,
        // 默认只勾选新增/改写；锁定片段与无变化片段默认排除
        selected: acceptableSeqs(batch, state),
      }
      const total = Object.keys(pending.entries).length
      let s: ConsoleState = { ...state, currentBatch: pending }
      s = withLog(
        s,
        'batch',
        null,
        action.at,
        `批次 ${batch.id} 收齐，${total} 条进入复核：默认勾选新增/改写，锁定内容已排除，可整批接受或逐条排除`,
      )
      return s
    }

    case 'batch-toggle': {
      const batch = state.currentBatch
      if (!batch || batch.phase !== 'pending') return state
      const entry = batch.entries[action.seq]
      if (!entry) return state
      const kind = classifyEntry(entry, state.segments[action.seq])
      if (kind !== 'new' && kind !== 'rewrite') return state // 冲突/无变化不可勾选
      const has = batch.selected.includes(action.seq)
      const selected = has
        ? batch.selected.filter((seq) => seq !== action.seq)
        : [...batch.selected, action.seq].sort((a, b) => a - b)
      return { ...state, currentBatch: { ...batch, selected } }
    }

    case 'batch-select-all': {
      const batch = state.currentBatch
      if (!batch || batch.phase !== 'pending') return state
      const selected = action.selected ? acceptableSeqs(batch, state) : []
      return { ...state, currentBatch: { ...batch, selected } }
    }

    case 'batch-accept':
      return acceptBatch(state, action.mode)

    case 'batch-undo':
      return undoBatchAccept(state)

    case 'batch-redo':
      return redoBatchAccept(state)

    case 'batch-archive': {
      // 关闭已完成批次的审计卡片；相关撤销/重做记录一并失效
      return {
        ...state,
        batchHistory: state.batchHistory.filter((b) => b.id !== action.batchId),
        undoStack: state.undoStack.filter((step) => step.batchId !== action.batchId),
        redoStack: state.redoStack.filter((step) => step.batchId !== action.batchId),
      }
    }

    case 'edit': {
      const seg = state.segments[action.seq]
      if (!seg || seg.locked) return state // 锁定片段不可直接编辑，需先解锁
      const text = action.text.trim()
      if (!text || text === seg.text) return state
      const next: SubtitleSegment = { ...seg, text, origin: 'manual' }
      let s: ConsoleState = { ...state, segments: { ...state.segments, [action.seq]: next } }
      s = withLog(s, 'manual', action.seq, null, `人工修改 #${action.seq}：「${text}」`)
      // 人工刚改过的片段，机器修订不能继续替用户勾选：移出选择，需重新勾选才会覆盖人工稿
      s = removeSelection(s, action.seq)
      return pruneSelection(s)
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
          : `已解锁 #${action.seq}，可纳入批次复核`,
      )
      // 批次复核中明确解锁：若该锁定冲突正是批次条目，解锁后自动纳入勾选
      const batch = s.currentBatch
      if (!locked && batch && batch.phase === 'pending' && batch.entries[action.seq]) {
        const kind = classifyEntry(batch.entries[action.seq], s.segments[action.seq])
        if (kind === 'new' || kind === 'rewrite') {
          if (!batch.selected.includes(action.seq)) {
            s = {
              ...s,
              currentBatch: {
                ...batch,
                selected: [...batch.selected, action.seq].sort((a, b) => a - b),
              },
            }
          }
        }
      }
      return pruneSelection(s)
    }

    case 'resolve-conflict': {
      const conflict = state.conflicts.find((c) => c.seq === action.seq)
      if (!conflict) return state
      const seg = state.segments[action.seq]
      const conflicts = state.conflicts.filter((c) => c.seq !== action.seq)
      if (action.choice === 'keep') {
        let s: ConsoleState = { ...state, conflicts }
        s = withLog(
          s,
          'resolved',
          action.seq,
          null,
          `保留人工版本，忽略机器修订 v${conflict.incomingVersion}（#${action.seq}）`,
        )
        return pruneSelection(s)
      }
      if (!seg) return pruneSelection({ ...state, conflicts })
      const next: SubtitleSegment = {
        ...seg,
        text: conflict.incomingText,
        version: conflict.incomingVersion,
        origin: 'machine',
        locked: false,
      }
      let s: ConsoleState = {
        ...state,
        conflicts,
        segments: { ...state.segments, [action.seq]: next },
      }
      s = withLog(
        s,
        'resolved',
        action.seq,
        null,
        `接受机器修订 v${conflict.incomingVersion}（#${action.seq}），片段解除锁定`,
      )
      return pruneSelection(s)
    }
  }
}

// ---------------------------------------------------------------------------
// 批次接收
// ---------------------------------------------------------------------------

function ingestIntoBatch(
  state: ConsoleState,
  event: SubtitleEvent,
  receivedAt: number | null,
): ConsoleState {
  const batch = state.currentBatch!

  // 事件级去重：重发事件绝不重复进入批次、更不会被重复应用
  if (state.seenEventIds[event.id]) {
    return withLog(
      state,
      'duplicate',
      event.seq,
      receivedAt,
      `批次 ${batch.id} 重复到达：${event.id}（#${event.seq} v${event.version}）已忽略，未重复套用`,
    )
  }

  const existing = state.segments[event.seq]

  // 相对时间线已过期/矛盾的版本：与批次外一致地忽略，不进缓冲
  if (
    existing &&
    (event.version < existing.version ||
      (event.version === existing.version && event.text !== existing.text))
  ) {
    const seenEventIds = { ...state.seenEventIds, [event.id]: true as const }
    return withLog(
      { ...state, seenEventIds },
      'stale',
      event.seq,
      receivedAt,
      `批次 ${batch.id} 中 #${event.seq} v${event.version} 相对当前 v${existing.version} 已过期，已忽略`,
    )
  }

  const seenEventIds = { ...state.seenEventIds, [event.id]: true as const }
  const previousEntries = batch.entries
  const prev = previousEntries[event.seq]
  const entries = mergeEntry(previousEntries, {
    id: event.id,
    seq: event.seq,
    version: event.version,
    text: event.text,
    receivedAt,
  })
  const merged = entries[event.seq]

  // 缓冲内容是否真的发生变化：新版本/新文本/新 seq 才算“更新”，纯重发不算
  const changed =
    !prev || prev.version !== merged.version || prev.text !== merged.text

  const logs: LogSpec[] = []
  if (!changed) {
    logs.push({
      kind: 'duplicate',
      seq: event.seq,
      at: receivedAt,
      message: `批次 ${batch.id} 中 #${event.seq} v${event.version} 重复内容，已忽略，仅保留一条待复核`,
    })
  } else if (existing && event.version === existing.version && event.text === existing.text) {
    logs.push({
      kind: 'batch',
      seq: event.seq,
      at: receivedAt,
      message: `批次 ${batch.id} 接收 #${event.seq} v${event.version}，与当前内容一致，列为无变化`,
    })
  } else {
    logs.push({
      kind: 'batch',
      seq: event.seq,
      at: receivedAt,
      message:
        batch.phase === 'pending'
          ? `复核进行中 #${event.seq} v${event.version} 才到达，批次 ${batch.id} 已标记过期并重新计算，请基于新内容重新选择`
          : `批次 ${batch.id} 接收 #${event.seq} v${event.version}，暂缓套用等待整批复核`,
    })
  }
  if (!existing && changed) {
    const maxSeq = maxSegmentSeq(state.segments)
    if (maxSeq !== null && event.seq < maxSeq) {
      logs.push({
        kind: 'backfilled',
        seq: event.seq,
        at: receivedAt,
        message: `批次 ${batch.id} 中的晚到片段 #${event.seq} 将在接受时补回缺口`,
      })
    }
  }

  let nextBatch: ReviewBatch = { ...batch, entries }
  if (batch.phase === 'pending' && changed) {
    // 复核中收到真实更新：标记过期并重算，针对旧内容的勾选全部作废，
    // 只有版本/文本都没变且仍可接受的条目保留选择。
    nextBatch = {
      ...nextBatch,
      staleSince: batch.staleSince ?? receivedAt,
      staleCount: batch.staleCount + 1,
      selected: reconcileSelection(entries, previousEntries, batch.selected, state),
    }
  }

  return logMany({ ...state, seenEventIds, currentBatch: nextBatch }, logs)
}

function maxSegmentSeq(segments: Record<number, SubtitleSegment>): number | null {
  const keys = Object.keys(segments)
  return keys.length > 0 ? Math.max(...keys.map(Number)) : null
}

// ---------------------------------------------------------------------------
// 接受 / 撤销 / 重做
// ---------------------------------------------------------------------------

function countKind(batch: ReviewBatch, state: ConsoleState, kind: 'conflict'): number {
  return Object.values(batch.entries).filter(
    (entry) => classifyEntry(entry, state.segments[entry.seq]) === kind,
  ).length
}

function acceptBatch(state: ConsoleState, mode: BatchAcceptMode): ConsoleState {
  const batch = state.currentBatch
  if (!batch || batch.phase !== 'pending') return state
  const eligible = acceptableSeqs(batch, state)
  const chosen = mode === 'all' ? eligible : batch.selected.filter((seq) => eligible.includes(seq))
  const uniqueChosen = [...new Set(chosen)].sort((a, b) => a - b)
  const conflictsLeftBefore = countKind(batch, state, 'conflict')

  // 没有可接受条目、且没有勾选时
  if (uniqueChosen.length === 0) {
    if (mode === 'selected') return state
    // 整批接受但仍有锁定冲突：不能替运营把锁定修订静默排除掉，保持复核
    if (mode === 'all' && conflictsLeftBefore > 0) {
      return withLog(
        state,
        'batch',
        null,
        null,
        `批次 ${batch.id} 仍有锁定冲突条目，已保留复核：请先在时间线解锁纳入，或选择「排除其余、完成复核」`,
      )
    }
    return finalizeBatch(state, batch)
  }

  const step: BatchHistoryStep = { batchId: batch.id, seqs: uniqueChosen, before: {}, after: [] }
  let segments = { ...state.segments }
  let conflicts = [...state.conflicts]
  const gapBefore = new Set(seqGaps(segments))
  const logs: LogSpec[] = []

  for (const seq of uniqueChosen) {
    const entry = batch.entries[seq]
    const beforeSeg = segments[seq] ?? null
    const beforeConflict = conflicts.find((c) => c.seq === seq) ?? null
    step.before[seq] = {
      segment: beforeSeg,
      hadConflict: beforeConflict !== null,
      conflict: beforeConflict,
    }
    step.after.push({ seq, text: entry.text, version: entry.version })

    if (!beforeSeg) {
      segments[seq] = { seq, text: entry.text, version: entry.version, origin: 'machine', locked: false }
      logs.push({
        kind: 'received',
        seq,
        at: entry.receivedAt,
        message: `批次接受新增 #${seq} v${entry.version}：「${entry.text}」`,
      })
      if (gapBefore.has(seq)) {
        logs.push({
          kind: 'backfilled',
          seq,
          at: entry.receivedAt,
          message: `批次接受的晚到片段 #${seq} 已补回缺口`,
        })
      }
    } else {
      const hadManualText = beforeSeg.origin === 'manual'
      segments[seq] = { ...beforeSeg, text: entry.text, version: entry.version, origin: 'machine' }
      logs.push({
        kind: 'revised',
        seq,
        at: entry.receivedAt,
        message:
          `批次接受机器修订 v${entry.version}（#${seq}）` +
          (hadManualText ? '，覆盖了未锁定的人工修改' : ''),
      })
    }
    // 接受新版本后，该 seq 上旧的待裁决冲突随之失效
    conflicts = conflicts.filter((c) => c.seq !== seq)
  }

  const accepted = [...new Set([...batch.accepted, ...uniqueChosen])].sort((a, b) => a - b)
  const selected = batch.selected.filter((seq) => !uniqueChosen.includes(seq))
  const updated: ReviewBatch = { ...batch, accepted, selected, staleSince: batch.staleSince }

  let s: ConsoleState = {
    ...state,
    segments,
    conflicts,
    undoStack: [...state.undoStack, step],
    redoStack: [], // 新接受之后旧的重做路径失效
    currentBatch: updated,
  }
  s = logMany(s, logs)

  const remaining = acceptableSeqs(updated, s)
  const conflictsLeft = countKind(updated, s, 'conflict')
  // 仍有锁定冲突时，只有运营显式「排除其余、完成复核」才能收尾；
  // 整批接受/接受所选保留复核现场，锁定修订绝不被静默排除。
  const explicitFinish = mode === 'finish'
  const done =
    (mode === 'all' || explicitFinish || remaining.length === 0) &&
    (explicitFinish || conflictsLeft === 0)
  if (!done) {
    const reason =
      conflictsLeft > 0
        ? `，另有 ${conflictsLeft} 条锁定冲突默认排除，解锁后可纳入或选择「排除其余、完成复核」`
        : `，剩余 ${remaining.length} 条继续复核`
    s = withLog(s, 'batch', null, null, `批次 ${batch.id} 已接受 ${uniqueChosen.length} 条（#${uniqueChosen.join('、#')}）${reason}`)
    return s
  }

  return finalizeBatch(s, updated)
}

/** 收尾批次：未接受的可接受条目记为明确排除 */
function finalizeBatch(state: ConsoleState, batch: ReviewBatch): ConsoleState {
  const accepted = batch.accepted
  const excluded = Object.keys(batch.entries)
    .map(Number)
    .filter((seq) => !accepted.includes(seq))
  const applied: ReviewBatch = {
    ...batch,
    phase: 'applied',
    appliedCount: accepted.length,
    excludedCount: excluded.length,
    selected: [],
  }
  let s: ConsoleState = {
    ...state,
    currentBatch: null,
    batchHistory: [...state.batchHistory.filter((b) => b.id !== applied.id), applied].slice(
      -MAX_BATCH_HISTORY,
    ),
  }
  return withLog(
    s,
    'batch',
    null,
    null,
    `批次 ${batch.id} 复核完成：接受 ${accepted.length} 条` +
      (excluded.length > 0 ? `，排除 ${excluded.length} 条（#${excluded.join('、#')}）` : '') +
      '，可撤销',
  )
}

function undoBatchAccept(state: ConsoleState): ConsoleState {
  const step = state.undoStack[state.undoStack.length - 1]
  if (!step) return state
  let segments = { ...state.segments }
  let conflicts = [...state.conflicts]

  // 按接受的逆序还原应用前快照，保证时间线回到操作之前
  for (const seq of [...step.seqs].reverse()) {
    const snap = step.before[seq]
    if (!snap) continue
    if (snap.segment) segments[seq] = snap.segment
    else delete segments[seq]
    conflicts = conflicts.filter((c) => c.seq !== seq)
    if (snap.hadConflict && snap.conflict) conflicts.push(snap.conflict)
  }

  // 批次可能已收尾并入审计历史：撤销时取回为待复核
  let currentBatch = state.currentBatch
  let batchHistory = state.batchHistory
  const histIdx = batchHistory.findIndex((b) => b.id === step.batchId)
  if (histIdx >= 0) {
    const [restored] = batchHistory.slice(histIdx, histIdx + 1)
    batchHistory = batchHistory.filter((_, i) => i !== histIdx)
    currentBatch = { ...restored, phase: 'pending' as const, staleSince: null }
  }
  if (currentBatch && currentBatch.id === step.batchId) {
    currentBatch = {
      ...currentBatch,
      phase: 'pending',
      accepted: currentBatch.accepted.filter((seq) => !step.seqs.includes(seq)),
      selected: [...new Set([...currentBatch.selected, ...step.seqs])].sort((a, b) => a - b),
    }
  }

  let s: ConsoleState = {
    ...state,
    segments,
    conflicts,
    currentBatch,
    batchHistory,
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, step],
  }
  return withLog(
    s,
    'batch',
    null,
    null,
    `撤销批次 ${step.batchId}：#${step.seqs.join('、#')} 共 ${step.seqs.length} 条已还原为接受前状态`,
  )
}

function redoBatchAccept(state: ConsoleState): ConsoleState {
  const step = state.redoStack[state.redoStack.length - 1]
  if (!step) return state
  const batch = state.currentBatch

  // 护栏：当前时间线/冲突必须与应用前快照逐位一致，否则不静默重做旧选择
  for (const seq of step.seqs) {
    const snap = step.before[seq]
    const seg = state.segments[seq] ?? null
    if (snap.segment) {
      if (!seg || seg.text !== snap.segment.text || seg.version !== snap.segment.version) return state
    } else if (seg) {
      return state
    }
    if (state.conflicts.some((c) => c.seq === seq) !== snap.hadConflict) return state
  }

  let segments = { ...state.segments }
  let conflicts = [...state.conflicts]
  const logs: LogSpec[] = []
  for (const after of step.after) {
    const beforeSeg = segments[after.seq]
    if (!beforeSeg) {
      segments[after.seq] = {
        seq: after.seq,
        text: after.text,
        version: after.version,
        origin: 'machine',
        locked: false,
      }
      logs.push({
        kind: 'received',
        seq: after.seq,
        at: null,
        message: `重做批次接受新增 #${after.seq} v${after.version}`,
      })
    } else {
      segments[after.seq] = {
        ...beforeSeg,
        text: after.text,
        version: after.version,
        origin: 'machine',
      }
      logs.push({ kind: 'revised', seq: after.seq, at: null, message: `重做批次接受修订 v${after.version}（#${after.seq}）` })
    }
    conflicts = conflicts.filter((c) => c.seq !== after.seq)
  }

  let currentBatch = batch
  let batchHistory = state.batchHistory
  if (currentBatch && currentBatch.id === step.batchId) {
    currentBatch = {
      ...currentBatch,
      accepted: [...new Set([...currentBatch.accepted, ...step.seqs])].sort((a, b) => a - b),
      selected: currentBatch.selected.filter((seq) => !step.seqs.includes(seq)),
    }
  }

  let s: ConsoleState = {
    ...state,
    segments,
    conflicts,
    currentBatch,
    batchHistory,
    undoStack: [...state.undoStack, step],
    redoStack: state.redoStack.slice(0, -1),
  }
  s = logMany(s, logs)

  if (currentBatch && currentBatch.id === step.batchId) {
    if (acceptableSeqs(currentBatch, s).length === 0) {
      const excluded = Object.keys(currentBatch.entries)
        .map(Number)
        .filter((seq) => !currentBatch.accepted.includes(seq))
      const applied: ReviewBatch = {
        ...currentBatch,
        phase: 'applied',
        appliedCount: currentBatch.accepted.length,
        excludedCount: excluded.length,
        selected: [],
      }
      s = {
        ...s,
        currentBatch: null,
        batchHistory: [...s.batchHistory.filter((b) => b.id !== applied.id), applied].slice(
          -MAX_BATCH_HISTORY,
        ),
      }
    } else {
      s = { ...s, currentBatch }
    }
  }

  return withLog(
    s,
    'batch',
    null,
    null,
    `重做批次 ${step.batchId}：#${step.seqs.join('、#')} 共 ${step.seqs.length} 条重新应用`,
  )
}

function seqGaps(segments: Record<number, SubtitleSegment>): number[] {
  const keys = Object.keys(segments).map(Number)
  if (keys.length === 0) return []
  const min = Math.min(...keys)
  const max = Math.max(...keys)
  const out: number[] = []
  for (let seq = min; seq <= max; seq += 1) {
    if (!segments[seq]) out.push(seq)
  }
  return out
}

// ---------------------------------------------------------------------------
// 批次外的常规接收（原有乱序/重复/锁定冲突语义）
// ---------------------------------------------------------------------------

function ingestDirect(
  state: ConsoleState,
  event: SubtitleEvent,
  receivedAt: number | null,
): ConsoleState {
  // 1) 事件级去重：同一事件 ID 只处理一次（批次中已见的事件日后补发也在此被拦下）
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
    const maxSeq = maxSegmentSeq(state.segments)
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
    return s
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
    const s = { ...s0, conflicts }
    return withLog(
      s,
      'conflict',
      event.seq,
      receivedAt,
      `#${event.seq} 已锁定，机器修订 v${event.version} 未覆盖人工内容，转入人工裁决`,
    )
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
  const s = { ...s0, conflicts, segments: { ...state.segments, [event.seq]: next } }
  const notes = [
    hadManualText ? '覆盖了未锁定的人工修改' : '',
    droppedConflict ? '旧的待裁决冲突已失效' : '',
  ]
    .filter(Boolean)
    .join('，')
  return withLog(
    s,
    'revised',
    event.seq,
    receivedAt,
    `机器修订 v${event.version} 已应用（#${event.seq}）${notes ? `，${notes}` : ''}`,
  )
}
