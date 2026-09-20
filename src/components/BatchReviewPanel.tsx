import type { ConsoleAction } from '../consoleReducer'
import type { BatchChangeKind, BatchItem, ConsoleState } from '../types'
import { batchSummary, selectableItems } from '../selectors'

interface BatchReviewPanelProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

const KIND_META: Record<BatchChangeKind, { icon: string; label: string; className: string }> = {
  added: { icon: '🆕', label: '新增', className: 'item--added' },
  revised: { icon: '✏️', label: '改写', className: 'item--revised' },
  conflict: { icon: '⚠️', label: '冲突', className: 'item--conflict' },
  unchanged: { icon: '⏺', label: '无变化', className: 'item--unchanged' },
  stale: { icon: '🗑️', label: '过期', className: 'item--stale' },
}

/** 批次复核面板：一次补发生成一个稳定批次，先看清单再整批/部分接受。 */
export function BatchReviewPanel({ state, dispatch }: BatchReviewPanelProps) {
  const batch = state.activeBatch
  if (!batch) return null
  const summary = batchSummary(batch)
  const selectable = selectableItems(batch)

  return (
    <section className="batch-panel" role="region" aria-label="批次复核">
      <header className="batch-head">
        <h2>
          <span aria-hidden="true">📦</span> 批次复核 · {batch.label}
          {batch.openedAt !== null && <span className="muted">到达于 +{(batch.openedAt / 1000).toFixed(1)}s</span>}
        </h2>
        <div className="batch-counts" aria-label="批次分类统计">
          <span className="bcount bcount--added">🆕 新增 {summary.added}</span>
          <span className="bcount bcount--revised">✏️ 改写 {summary.revised}</span>
          <span className="bcount bcount--conflict">⚠️ 冲突 {summary.conflict}</span>
          <span className="bcount bcount--unchanged">⏺ 无变化 {summary.unchanged}</span>
          {summary.stale > 0 && <span className="bcount bcount--stale">🗑️ 过期 {summary.stale}</span>}
        </div>
      </header>

      {batch.stale && (
        <div className="batch-stale" role="alert">
          <span aria-hidden="true">🔄</span>
          <div>
            <strong>批次已过期：</strong>复核期间时间线又收到机器更新，候选已按最新内容重新计算，旧勾选已清空。
            <button
              type="button"
              className="btn btn--recalc"
              onClick={() => dispatch({ type: 'batch-recalculate' })}
            >
              确认并继续复核
            </button>
          </div>
        </div>
      )}

      {selectable.length > 0 && (
        <div className="batch-toolbar">
          <label className="select-all">
            <input
              type="checkbox"
              checked={summary.allSelected}
              ref={(el) => {
                if (el) el.indeterminate = summary.selected > 0 && !summary.allSelected
              }}
              onChange={(e) => dispatch({ type: 'batch-select-all', selected: e.target.checked })}
            />
            全选可接受条目（{summary.selected}/{summary.selectable}）
          </label>
        </div>
      )}

      <ul className="batch-list">
        {batch.items.map((item) => (
          <BatchRow key={item.seq} item={item} dispatch={dispatch} />
        ))}
      </ul>

      <footer className="batch-actions">
        <button
          type="button"
          className="btn btn--accept"
          disabled={summary.selected === 0 || batch.stale}
          title={batch.stale ? '批次已过期，请先确认重新计算' : '只应用被勾选的条目'}
          onClick={() => dispatch({ type: 'batch-accept' })}
        >
          ✅ 接受所选（{summary.selected}）
        </button>
        <button
          type="button"
          className="btn btn--close"
          onClick={() => dispatch({ type: 'batch-close' })}
        >
          ✕ 关闭批次（放弃未接受项）
        </button>
      </footer>
    </section>
  )
}

function BatchRow({ item, dispatch }: { item: BatchItem; dispatch: (a: ConsoleAction) => void }) {
  const meta = KIND_META[item.kind]
  const selectable = !item.locked && (item.kind === 'added' || item.kind === 'revised')
  return (
    <li className={`batch-item ${meta.className}${item.selected ? ' item--selected' : ''}`}>
      <div className="batch-item-check">
        <input
          type="checkbox"
          aria-label={`#${item.seq} 是否纳入本批接受`}
          checked={item.selected}
          disabled={!selectable}
          onChange={(e) => dispatch({ type: 'batch-toggle-item', seq: item.seq, selected: e.target.checked })}
        />
      </div>
      <div className="batch-item-body">
        <div className="batch-item-head">
          <span className="seq">#{item.seq}</span>
          <span className={`bkind ${meta.className}`}>
            {meta.icon} {meta.label}
          </span>
          <span className="chip">
            {item.currentVersion !== null ? `v${item.currentVersion}` : '无片段'} → v{item.incomingVersion}
          </span>
          {item.locked && <span className="chip chip--locked">🔒 已锁定 · 默认排除</span>}
          {item.kind === 'unchanged' && <span className="muted">内容相同，无需处理</span>}
          {item.kind === 'stale' && <span className="muted">批次版本不新于当前，不可接受</span>}
        </div>
        <div className="batch-diff">
          <div className="diff-col diff-col--current">
            <h4>当前</h4>
            <p>{item.currentText ?? <em className="muted">（尚不存在，接受后新增）</em>}</p>
          </div>
          <span className="diff-arrow" aria-hidden="true">→</span>
          <div className="diff-col diff-col--incoming">
            <h4>批次内容</h4>
            <p>{item.incomingText}</p>
          </div>
        </div>
        {item.kind === 'conflict' && (
          <div className="batch-item-note">
            <span>锁定片段不会进入批次；明确解锁后才可勾选接受。</span>
            <button
              type="button"
              className="btn btn--unlock"
              onClick={() => dispatch({ type: 'toggle-lock', seq: item.seq })}
            >
              🔓 解锁 #{item.seq}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
