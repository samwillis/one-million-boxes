import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { GameState } from "../../shared/game-state"
import { GAME_START_TIMESTAMP_KEY } from "../../shared/game-config"
import { BoxBitmap } from "../lib/box-bitmap"
import { playBoxSound, playPencilSound } from "../lib/game-sounds"
import { useBoardRealtime } from "../hooks/useBoardRealtime"
import { useTeam } from "./team-context"
import { QUOTA_KEY, useQuota } from "./quota-context"
import type { BoardTile } from "../../shared/tiles"
import type { ReactNode } from "react"

// Local storage key for user's completed boxes (must match quota-context.tsx)
const LOCAL_BOXES_KEY = `boxes:local-completed`
const OUT_OF_MOVES_MESSAGE = `Out of moves! Recharging...`

export interface RecentEvent {
  id: number
  edgeId: number
  teamId: number
  timestamp: number
  isLocal: boolean // true if placed by the current user
}

export interface GameStateContextValue {
  gameState: GameState
  boxBitmap: BoxBitmap
  pendingEdge: number | null
  placeEdge: (edgeId: number) => void
  isConnected: boolean
  isLoading: boolean
  isReadyToRender: boolean
  notifyCanvasRendered: () => void
  error: string | null
  version: number
  recentEvents: Array<RecentEvent>
  isGameComplete: boolean
  winner: number | null // teamId (0-3) or null if tie
}

const GameStateContext = createContext<GameStateContextValue | null>(null)

export interface GameStateProviderProps {
  children: ReactNode
}

// How long to keep recent events for animation (ms)
const RECENT_EVENT_TTL = 1000

export function GameStateProvider({ children }: GameStateProviderProps) {
  // Use a ref for the game state to avoid re-renders on every event
  const gameStateRef = useRef<GameState>(new GameState())

  // Shared bitmap for rendering (1px per box, used by minimap and main canvas)
  const boxBitmapRef = useRef<BoxBitmap>(new BoxBitmap())

  // Version counter to trigger re-renders when needed
  const [version, setVersion] = useState(0)

  // UI state
  const [pendingEdge, setPendingEdge] = useState<number | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isReadyToRender, setIsReadyToRender] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track recent events for minimap pop animation
  const [recentEvents, setRecentEvents] = useState<Array<RecentEvent>>([])
  const eventIdRef = useRef(0)
  // Track edge IDs placed by the local user (to identify local vs remote events)
  const localEdgeIdsRef = useRef<Set<number>>(new Set())

  // Suppress move animations while installing the initial board snapshot.
  const initialSyncCompleteRef = useRef(false)
  const pendingFirstRenderRef = useRef(false)
  const snapshotAppliedAtRef = useRef(0)

  // 60fps render throttling - only update version once per frame
  const renderScheduledRef = useRef(false)
  const pendingRecentEventsRef = useRef<Array<RecentEvent>>([])
  const bitmapDirtyRef = useRef(false)

  // Get team and quota from contexts
  const { teamId } = useTeam()
  const { consume, syncFromServer, refund, remaining, notifyNoMoves } = useQuota()

  // Schedule a render for next animation frame (60fps throttle)
  const scheduleRender = useCallback(() => {
    if (renderScheduledRef.current) return

    renderScheduledRef.current = true
    requestAnimationFrame(() => {
      renderScheduledRef.current = false

      // Commit bitmap if dirty
      if (bitmapDirtyRef.current) {
        boxBitmapRef.current.commit()
        bitmapDirtyRef.current = false
      }

      // Add pending recent events
      if (pendingRecentEventsRef.current.length > 0) {
        const newEvents = pendingRecentEventsRef.current
        pendingRecentEventsRef.current = []
        const now = Date.now()
        setRecentEvents((prev) => {
          const cutoff = now - RECENT_EVENT_TTL
          const filtered = prev.filter((e) => e.timestamp > cutoff)
          return [...filtered, ...newEvents]
        })
      }

      // Trigger re-render
      setVersion((v) => v + 1)
    })
  }, [])

  // Install tile owners directly; unordered snapshots must never infer box claims.
  const handleTiles = useCallback(
    (tiles: readonly BoardTile[], reset: boolean) => {
      if (reset) {
        setIsLoading(true)
        gameStateRef.current = new GameState()
        localEdgeIdsRef.current.clear()
        pendingRecentEventsRef.current = []
        setRecentEvents([])
      }
      const now = Date.now()
      for (const tile of tiles) {
        const { edgesChanged, boxesChanged } = gameStateRef.current.applyTile(tile)
        if (!reset) {
          for (const boxId of boxesChanged) {
            const owner = gameStateRef.current.getBoxOwner(boxId)
            boxBitmapRef.current.updateBox(boxId, owner - 1)
            bitmapDirtyRef.current = true
          }
          for (const event of edgesChanged) {
            const isLocal = localEdgeIdsRef.current.delete(event.edgeId)
            pendingRecentEventsRef.current.push({
              ...event,
              id: eventIdRef.current++,
              timestamp: now,
              isLocal,
            })
          }
        }
      }
      setPendingEdge((current) =>
        current !== null && gameStateRef.current.isEdgeTaken(current) ? null : current,
      )
      if (reset) {
        initialSyncCompleteRef.current = true
        boxBitmapRef.current.rebuildFromState(gameStateRef.current)
        bitmapDirtyRef.current = false
        pendingFirstRenderRef.current = true
        snapshotAppliedAtRef.current = performance.now()
        setIsReadyToRender(true)
        setVersion((value) => value + 1)
      } else scheduleRender()
    },
    [scheduleRender],
  )

  // Handle connection events
  const handleConnected = useCallback(() => {
    setIsConnected(true)
    if (initialSyncCompleteRef.current && !pendingFirstRenderRef.current) {
      setIsLoading(false)
    }
    setError(null)
  }, [])

  const handleDisconnected = useCallback(() => {
    setIsConnected(false)
  }, [])

  const handleError = useCallback((err: Error) => {
    setError(err.message)
  }, [])

  // Clear the recharge prompt as soon as another move becomes available.
  useEffect(() => {
    if (remaining > 0 && error === OUT_OF_MOVES_MESSAGE) {
      setError(null)
    }
  }, [remaining, error])

  const notifyCanvasRendered = useCallback(() => {
    if (pendingFirstRenderRef.current) {
      console.info("[Board Realtime] First canvas rendered", {
        sinceStateAppliedMs: Math.round(performance.now() - snapshotAppliedAtRef.current),
      })
      pendingFirstRenderRef.current = false
      setIsReadyToRender(false)
      setIsLoading(false)
    }
  }, [])

  // Handle the game timestamp from the metadata subscription.
  // If the timestamp changes (game reset), clear client-side cached data
  const handleGameStartTimestamp = useCallback((timestamp: number) => {
    try {
      // Validate the incoming timestamp
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        console.warn(`[GameState] Invalid timestamp received:`, timestamp)
        return
      }

      const storedTimestamp = localStorage.getItem(GAME_START_TIMESTAMP_KEY)
      const storedValue = storedTimestamp ? parseInt(storedTimestamp, 10) : null

      // Validate stored value - if invalid, treat as no stored value
      const validStoredValue =
        storedValue !== null && Number.isFinite(storedValue) && storedValue > 0 ? storedValue : null

      if (validStoredValue !== null && validStoredValue !== timestamp) {
        // Game has been reset - clear stale client data
        console.log(`[GameState] Game reset detected. Old: ${validStoredValue}, New: ${timestamp}`)
        localStorage.removeItem(QUOTA_KEY)
        localStorage.removeItem(LOCAL_BOXES_KEY)
        // Force a page reload to reset all state
        window.location.reload()
      }

      // Store the current timestamp
      localStorage.setItem(GAME_START_TIMESTAMP_KEY, String(timestamp))
    } catch (err) {
      console.error(`[GameState] Error handling game start timestamp:`, err)
      // Clear potentially corrupted localStorage data
      localStorage.removeItem(GAME_START_TIMESTAMP_KEY)
    }
  }, [])

  // Subscribe to authoritative tiles and game metadata.
  const { awaitTxId, reconnect } = useBoardRealtime({
    onTiles: handleTiles,
    onError: handleError,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    onGameStartTimestamp: handleGameStartTimestamp,
  })

  // Place an edge on the board
  const placeEdge = useCallback(
    async (edgeId: number) => {
      if (!isConnected || !initialSyncCompleteRef.current) return
      // Clear any previous error on new attempt
      setError(null)

      // Check if edge is already taken
      if (gameStateRef.current.isEdgeTaken(edgeId)) {
        return
      }

      // Optimistically consume quota (will be synced from server response)
      if (!consume()) {
        setError(OUT_OF_MOVES_MESSAGE)
        return
      }

      // Set pending edge for optimistic UI
      setPendingEdge(edgeId)
      playPencilSound()

      // Track as local edge for pop animation filtering
      localEdgeIdsRef.current.add(edgeId)

      try {
        const response = await fetch(`/api/draw`, {
          method: `POST`,
          headers: { "Content-Type": `application/json` },
          body: JSON.stringify({ edgeId }),
        })
        const result = await response.json()

        if (result.ok) {
          if (typeof result.boxesClaimed === "number") playBoxSound(result.boxesClaimed)
          // Success - Realtime will confirm the committed transaction.
          // Sync quota from server (includes any refunds for completed boxes)
          if (typeof result.quotaRemaining === `number`) {
            syncFromServer(result.quotaRemaining, result.refillIn, result.boxesClaimed)
          }
          try {
            await awaitTxId(result.txid)
          } catch {
            reconnect()
            setError(`Move saved; waiting for synchronization`)
          }
        } else {
          // Handle error codes
          // Sync quota from server response if provided (even on errors)
          if (typeof result.quotaRemaining === `number`) {
            syncFromServer(result.quotaRemaining, result.refillIn)
          }

          switch (result.code) {
            case `EDGE_TAKEN`:
              // Server already refunded - quota synced above
              setError(null) // Not really an error, just already taken
              break
            case `QUOTA_EXHAUSTED`:
              // Server says no quota - already synced above
              notifyNoMoves()
              setError(OUT_OF_MOVES_MESSAGE)
              break
            case `NO_IDENTITY`:
              refund() // Fallback refund if no server quota info
              setError(`No team assigned - please refresh`)
              break
            case `GAME_COMPLETE`:
              refund()
              setError(`Game is complete!`)
              break
            case `INVALID_EDGE`:
              refund()
              setError(`Invalid edge`)
              break
            case `DATABASE_ERROR`:
              refund()
              setError(`Database error - please try again`)
              break
            default:
              refund()
              setError(`Failed to place edge: ${result.code}`)
          }

          // Clear pending edge on error
          localEdgeIdsRef.current.delete(edgeId)
          setPendingEdge(null)
        }
      } catch (err) {
        // Network error - refund locally since we can't reach server
        refund()
        localEdgeIdsRef.current.delete(edgeId)
        setPendingEdge(null)
        setError(err instanceof Error ? err.message : `Failed to place edge`)
      }
    },
    [consume, syncFromServer, refund, teamId, awaitTxId, reconnect, isConnected, notifyNoMoves],
  )

  const value: GameStateContextValue = {
    gameState: gameStateRef.current,
    boxBitmap: boxBitmapRef.current,
    pendingEdge,
    placeEdge,
    isConnected,
    isLoading,
    isReadyToRender,
    notifyCanvasRendered,
    error,
    version,
    recentEvents,
    isGameComplete: gameStateRef.current.isComplete(),
    winner: gameStateRef.current.getWinner(),
  }

  return <GameStateContext.Provider value={value}>{children}</GameStateContext.Provider>
}

export function useGameStateContext(): GameStateContextValue {
  const ctx = useContext(GameStateContext)
  if (!ctx) {
    throw new Error(`useGameStateContext must be used within GameStateProvider`)
  }
  return ctx
}
