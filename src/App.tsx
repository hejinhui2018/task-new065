import { useSubtitleConsole } from './useSubtitleConsole'
import {
  currentBatchView,
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
import { PlaybackControls } from './components/PlaybackControls'

export default function App() {
  const { state, dispatch, player } = useSubtitleConsole()
  const batch = currentBatchView(state)

  return (
    <div className="console">
      <Header
        segmentCount={sortedSegments(state).length}
        gapCount={gaps(state).length}
        duplicateCount={duplicateCount(state)}
        conflictCount={state.conflicts.length}
        lockedCount={lockedCount(state)}
        batchCount={batch?.items.length ?? 0}
      />
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
