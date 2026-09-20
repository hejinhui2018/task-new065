import { useSubtitleConsole } from './useSubtitleConsole'
import {
  duplicateCount,
  firstBlockingGap,
  gaps,
  lockedCount,
  onAirSegment,
  onAirSeq,
  sortedSegments,
  upcomingSegments,
} from './selectors'
import { Header } from './components/Header'
import { PreviewPane } from './components/PreviewPane'
import { TimelinePane } from './components/TimelinePane'
import { EventLogPane } from './components/EventLogPane'
import { ConflictPanel } from './components/ConflictPanel'
import { BatchReviewPanel } from './components/BatchReviewPanel'
import { HistoryControls } from './components/HistoryControls'
import { PlaybackControls } from './components/PlaybackControls'

export default function App() {
  const { state, dispatch, player } = useSubtitleConsole()

  return (
    <div className="console">
      <Header
        segmentCount={sortedSegments(state).length}
        gapCount={gaps(state).length}
        duplicateCount={duplicateCount(state)}
        conflictCount={state.conflicts.length}
        lockedCount={lockedCount(state)}
      />
      <div className="action-bar">
        <HistoryControls state={state} dispatch={dispatch} />
        {state.activeBatch && <span className="batch-live-chip">📦 批次复核进行中</span>}
      </div>
      <ConflictPanel state={state} dispatch={dispatch} />
      <BatchReviewPanel state={state} dispatch={dispatch} />
      <main className="grid">
        <PreviewPane
          onAir={onAirSegment(state)}
          blockingGap={firstBlockingGap(state)}
          upcoming={upcomingSegments(state)}
        />
        <TimelinePane state={state} onAirSeq={onAirSeq(state)} dispatch={dispatch} />
        <EventLogPane log={state.log} />
      </main>
      <PlaybackControls player={player} />
    </div>
  )
}
