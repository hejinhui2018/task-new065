import { useEffect, useReducer, useRef } from 'react'
import { consoleReducer, createInitialState } from './consoleReducer'
import { Player } from './player'
import { SCENARIO } from './scenario'
import { loadState, saveState } from './storage'

/** 把纯函数 reducer 与播放器装配成 React 可用的整体。 */
export function useSubtitleConsole() {
  const [state, dispatch] = useReducer(
    consoleReducer,
    undefined,
    () => {
      // 刷新恢复：浏览器环境读取 localStorage；不可用时回退干净初始状态
      try {
        return loadState(window.localStorage)
      } catch {
        return createInitialState()
      }
    },
  )
  const playerRef = useRef<Player | null>(null)
  if (playerRef.current === null) {
    playerRef.current = new Player(SCENARIO, dispatch)
  }
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    const player = playerRef.current!
    const unsubscribe = player.subscribe(bump)
    return () => {
      unsubscribe()
      player.dispose()
    }
  }, [])

  // 每次状态变化后持久化复核现场（纯数据序列化，失败不影响使用）
  useEffect(() => {
    try {
      saveState(window.localStorage, state)
    } catch {
      // 隐私模式/配额不足时静默降级为内存态
    }
  }, [state])

  return { state, dispatch, player: playerRef.current }
}
