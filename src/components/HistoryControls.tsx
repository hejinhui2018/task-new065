import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState } from '../types'
import { canRedo, canUndo, redoLabel, undoLabel } from '../selectors'

interface HistoryControlsProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

/** 撤销 / 重做：批次接受、关闭、人工修改、锁定、冲突裁决均可回退。 */
export function HistoryControls({ state, dispatch }: HistoryControlsProps) {
  const undoText = undoLabel(state)
  const redoText = redoLabel(state)
  return (
    <div className="history-controls" role="group" aria-label="撤销与重做">
      <button
        type="button"
        className="btn btn--undo"
        disabled={!canUndo(state)}
        title={undoText ? `撤销：${undoText}` : '没有可撤销的操作'}
        onClick={() => dispatch({ type: 'undo' })}
      >
        ↶ 撤销
      </button>
      <button
        type="button"
        className="btn btn--redo"
        disabled={!canRedo(state)}
        title={redoText ? `重做：${redoText}` : '没有可重做的操作'}
        onClick={() => dispatch({ type: 'redo' })}
      >
        ↷ 重做
      </button>
    </div>
  )
}
