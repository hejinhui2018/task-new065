import { useState } from 'react'
import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState, SubtitleSegment } from '../types'
import { seqRange } from '../selectors'

interface TimelinePaneProps {
  state: ConsoleState
  onAirSeq: number | null
  dispatch: (action: ConsoleAction) => void
}

/** 字幕时间线：按序号排列，缺口占位、可编辑、可锁定。 */
export function TimelinePane({ state, onAirSeq, dispatch }: TimelinePaneProps) {
  const rows = seqRange(state)
  // 批次中尚未落位的新增 seq（超出当前序号范围）：以幽灵行占位，
  // 让时间线与批次复核内容始终一致
  const pendingNewSeqs =
    state.currentBatch && state.currentBatch.phase !== 'applied'
      ? Object.keys(state.currentBatch.entries)
          .map(Number)
          .filter((seq) => !state.segments[seq] && !rows.includes(seq))
          .sort((a, b) => a - b)
      : []
  const allRows = [...rows, ...pendingNewSeqs].sort((a, b) => a - b)
  return (
    <section className="pane timeline-pane" aria-label="字幕时间线">
      <h2>
        <span aria-hidden="true">🧾</span> 字幕时间线
      </h2>
      {allRows.length === 0 ? (
        <p className="muted">尚未收到字幕。点击下方「▶ 播放」开始接收事件流。</p>
      ) : (
        <ul className="timeline">
          {allRows.map((seq) => {
            const seg = state.segments[seq]
            const batchEntry =
              state.currentBatch && state.currentBatch.phase !== 'applied'
                ? state.currentBatch.entries[seq]
                : undefined
            if (!seg && batchEntry) {
              return <BatchPendingRow key={seq} seq={seq} text={batchEntry.text} version={batchEntry.version} />
            }
            if (!seg) return <GapRow key={seq} seq={seq} />
            return (
              <SegmentRow
                key={seq}
                seg={seg}
                isOnAir={seq === onAirSeq}
                hasConflict={state.conflicts.some((c) => c.seq === seq)}
                inBatch={Boolean(batchEntry)}
                dispatch={dispatch}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

function BatchPendingRow({ seq, text, version }: { seq: number; text: string; version: number }) {
  return (
    <li className="row gap-row batch-pending-row" aria-label={`#${seq} 批次待接受`}>
      <span className="seq">#{seq}</span>
      <span className="gap-label">
        <span aria-hidden="true">📦</span> 批次待接受 · v{version}
      </span>
      <span className="seg-text batch-pending-text">{text}</span>
    </li>
  )
}

function GapRow({ seq }: { seq: number }) {
  return (
    <li className="row gap-row" aria-label={`#${seq} 缺口`}>
      <span className="seq">#{seq}</span>
      <span className="gap-label">
        <span aria-hidden="true">⚠️</span> 缺口 · 片段缺失，等待晚到补齐
      </span>
    </li>
  )
}

interface SegmentRowProps {
  seg: SubtitleSegment
  isOnAir: boolean
  hasConflict: boolean
  inBatch: boolean
  dispatch: (action: ConsoleAction) => void
}

function SegmentRow({ seg, isOnAir, hasConflict, inBatch, dispatch }: SegmentRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(seg.text)

  const save = () => {
    dispatch({ type: 'edit', seq: seg.seq, text: draft })
    setEditing(false)
  }

  const rowClass = [
    'row',
    'seg-row',
    isOnAir ? 'seg-row--onair' : '',
    seg.locked ? 'seg-row--locked' : '',
    hasConflict ? 'seg-row--conflict' : '',
    inBatch ? 'seg-row--inbatch' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={rowClass}>
      <div className="row-head">
        <span className="seq">#{seg.seq}</span>
        <span className="chip">v{seg.version}</span>
        <span className={`chip ${seg.origin === 'manual' ? 'chip--manual' : ''}`}>
          {seg.origin === 'manual' ? '✍️ 人工' : '🤖 机器'}
        </span>
        {isOnAir && <span className="chip chip--live">▶ 播出中</span>}
        {seg.locked && <span className="chip chip--locked">🔒 已锁定</span>}
        {hasConflict && <span className="chip chip--danger">⚠️ 冲突待裁决</span>}
        {inBatch && <span className="chip chip--batch">📦 批次复核中</span>}
        <span className="row-actions">
          {!editing && (
            <button
              type="button"
              onClick={() => {
                setDraft(seg.text)
                setEditing(true)
              }}
              disabled={seg.locked}
              title={seg.locked ? '已锁定的片段不能直接修改，请先解锁' : '修改这条字幕'}
            >
              ✏️ 修改
            </button>
          )}
          <button type="button" onClick={() => dispatch({ type: 'toggle-lock', seq: seg.seq })}>
            {seg.locked ? '🔓 解锁' : '🔒 锁定'}
          </button>
        </span>
      </div>
      {editing ? (
        <div className="editor">
          <textarea
            value={draft}
            rows={2}
            aria-label={`编辑 #${seg.seq} 字幕文本`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="editor-actions">
            <button type="button" className="btn-primary" onClick={save} disabled={!draft.trim()}>
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </span>
        </div>
      ) : (
        <p className="seg-text">{seg.text}</p>
      )}
    </li>
  )
}
