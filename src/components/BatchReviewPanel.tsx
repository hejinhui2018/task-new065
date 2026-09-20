import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState } from '../types'
import { batchView, type BatchView, type BatchViewItem } from '../batch'

interface BatchReviewPanelProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

const KIND_META = {
  new: { icon: '🆕', label: '新增', className: 'batch-item--new' },
  rewrite: { icon: '✏️', label: '改写', className: 'batch-item--rewrite' },
  conflict: { icon: '🔒', label: '锁定冲突', className: 'batch-item--conflict' },
  noop: { icon: '⚪', label: '无变化', className: 'batch-item--noop' },
} as const

/** 批次复核：列出新增/改写/冲突/无变化，支持整批接受、逐条排除、撤销重做。 */
export function BatchReviewPanel({ state, dispatch }: BatchReviewPanelProps) {
  const open = state.currentBatch?.phase === 'open' ? state.currentBatch : null
  const view: BatchView | null =
    state.currentBatch && state.currentBatch.phase === 'pending'
      ? batchView(state.currentBatch, state)
      : null

  return (
    <>
      {open && (
        <section className="batch-panel batch-panel--open" aria-label="批次收集中">
          <h2>
            <span aria-hidden="true">📦</span> 补发批次 {open.id} 收集中…
            <span className="muted">已缓冲 {Object.keys(open.entries).length} 条，收齐后整批进入复核</span>
          </h2>
        </section>
      )}

      {view && <PendingBatch view={view} state={state} dispatch={dispatch} />}

      {state.batchHistory.length > 0 && (
        <section className="batch-history" aria-label="已完成批次">
          {state.batchHistory
            .slice()
            .reverse()
            .map((batch) => (
              <div className="batch-done-card" key={batch.id}>
                <div className="batch-done-main">
                  <strong>
                    <span aria-hidden="true">✅</span> 批次 {batch.id} 复核完成
                  </strong>
                  <span className="muted">
                    接受 {batch.appliedCount} 条 · 排除 {batch.excludedCount} 条
                    {batch.staleCount > 0 && ` · 过期重算 ${batch.staleCount} 次`}
                  </span>
                </div>
                <span className="row-actions">
                  <button
                    type="button"
                    disabled={state.undoStack[state.undoStack.length - 1]?.batchId !== batch.id}
                    onClick={() => dispatch({ type: 'batch-undo' })}
                  >
                    ↩ 撤销
                  </button>
                  <button
                    type="button"
                    className="batch-close"
                    title="关闭审计卡片"
                    onClick={() => dispatch({ type: 'batch-archive', batchId: batch.id })}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
        </section>
      )}
    </>
  )
}

function PendingBatch({
  view,
  state,
  dispatch,
}: {
  view: BatchView
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}) {
  const { batch, items } = view
  const canUndo = state.undoStack.length > 0
  const canRedo = state.redoStack.length > 0

  return (
    <section className="batch-panel" role="region" aria-label="批次复核">
      <header className="batch-head">
        <h2>
          <span aria-hidden="true">📦</span> 批次复核 · {batch.id}
          <span className="muted">
            收齐于 {batch.openedAt !== null ? `+${(batch.openedAt / 1000).toFixed(1)}s` : '手动'}
          </span>
        </h2>
        <div className="batch-summary" aria-live="polite">
          <span className="chip chip--ok">🆕 新增 {view.newCount}</span>
          <span className="chip chip--rewrite">✏️ 改写 {view.rewriteCount}</span>
          <span className="chip chip--locked">🔒 锁定冲突 {view.conflictCount}</span>
          <span className="chip">⚪ 无变化 {view.noopCount}</span>
          {view.duplicateCount > 0 && (
            <span className="chip chip--warn">🔁 重复到达 {view.duplicateCount}</span>
          )}
        </div>
        <span className="row-actions batch-history-actions">
          <button type="button" onClick={() => dispatch({ type: 'batch-undo' })} disabled={!canUndo}>
            ↩ 撤销
          </button>
          <button type="button" onClick={() => dispatch({ type: 'batch-redo' })} disabled={!canRedo}>
            ↪ 重做
          </button>
        </span>
      </header>

      {batch.staleSince !== null && (
        <div className="batch-stale-banner" role="alert">
          <span aria-hidden="true">⚠️</span>
          复核进行中又收到更新（第 {batch.staleCount} 次），批次已过期并重新计算：
          针对旧内容的勾选已作废，请基于下方最新内容重新选择，系统不会替你套用旧选择。
        </div>
      )}

      <div className="batch-selectall">
        <label>
          <input
            type="checkbox"
            checked={view.allSelected}
            onChange={(e) => dispatch({ type: 'batch-select-all', selected: e.target.checked })}
          />
          全选新增/改写（锁定与无变化项始终排除）
        </label>
        <span className="muted">已选 {items.filter((it) => it.selected).length} 条</span>
      </div>

      <ul className="batch-list">
        {items.map((item) => (
          <BatchItemRow key={item.seq} item={item} dispatch={dispatch} />
        ))}
      </ul>

      <div className="batch-actions">
        <button
          type="button"
          className="btn btn--accept"
          disabled={!view.hasSelection}
          onClick={() => dispatch({ type: 'batch-accept', mode: 'selected' })}
        >
          ✓ 接受所选{view.hasSelection ? `（${items.filter((it) => it.selected).length} 条）` : ''}
        </button>
        <button
          type="button"
          className="btn"
          disabled={view.acceptable.length === 0}
          onClick={() => dispatch({ type: 'batch-accept', mode: 'all' })}
        >
          ✓✓ 整批接受（{view.acceptable.length} 条可接受）
        </button>
        <button
          type="button"
          className="btn btn--keep"
          onClick={() => dispatch({ type: 'batch-accept', mode: 'finish' })}
        >
          ✋ 接受勾选并排除其余、完成复核
        </button>
      </div>
      <p className="batch-tip muted">
        锁定片段默认排除：在下方时间线明确解锁后会自动纳入；无变化片段不会被应用。
        部分接受后可继续逐条处理，接受完成前随时可撤销/重做，刷新页面复核现场保留。
      </p>
    </section>
  )
}

function BatchItemRow({
  item,
  dispatch,
}: {
  item: BatchViewItem
  dispatch: (action: ConsoleAction) => void
}) {
  const meta = KIND_META[item.kind]
  const checkable = item.kind === 'new' || item.kind === 'rewrite'
  return (
    <li className={`batch-item ${meta.className}${item.selected ? ' batch-item--selected' : ''}`}>
      <label className="batch-item-check">
        <input
          type="checkbox"
          checked={item.selected}
          disabled={!checkable}
          onChange={() => dispatch({ type: 'batch-toggle', seq: item.seq })}
        />
      </label>
      <div className="batch-item-body">
        <div className="batch-item-head">
          <span className="seq">#{item.seq}</span>
          <span className="chip">{meta.icon} {meta.label}</span>
          <span className="chip">🤖 待入 v{item.version}</span>
          {item.current && <span className="chip">当前 v{item.current.version}</span>}
          {item.eventIds.length > 1 && (
            <span className="chip chip--warn">🔁 重发 ×{item.eventIds.length}</span>
          )}
          {item.lockedOut && <span className="chip chip--locked">默认排除</span>}
          {item.kind === 'noop' && <span className="chip">无需应用</span>}
        </div>
        <div className="batch-item-cols">
          <div className="col">
            <h4>{item.current ? '当前时间线' : '时间线尚无此片段'}</h4>
            <p>{item.current ? item.current.text : '—（接受后作为新增片段补入）—'}</p>
          </div>
          <div className="col">
            <h4>批次机器版本</h4>
            <p>{item.text}</p>
          </div>
        </div>
        {item.lockedOut && (
          <p className="batch-item-note">
            🔒 该片段已人工锁定，不会被批次覆盖。如需采用机器版本，请先到时间线解锁，
            解锁后此条将自动进入勾选。
          </p>
        )}
      </div>
    </li>
  )
}
