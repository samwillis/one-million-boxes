import { useCallback, useEffect, useRef } from "react"
import { createRealtimeClient, QueryRefreshController } from "@neon/realtime/client"
import type { RawLiveQuerySubscription, SealedLiveQuery } from "@neon/realtime/client"
import { TILE_COUNT } from "../../shared/tiles"
import type { BoardTile } from "../../shared/tiles"
import { boardPayloadSize } from "../lib/realtime-diagnostics"

interface Bootstrap {
  url: string
  startedAt: number
  query: SealedLiveQuery<BoardTile>
  gameQuery: SealedLiveQuery<{ started_at: number | string }>
}

export function useBoardRealtime(options: {
  onTiles: (tiles: readonly BoardTile[], reset: boolean) => void
  onGameStartTimestamp: (timestamp: number) => void
  onConnected: () => void
  onDisconnected: () => void
  onError: (error: Error) => void
}) {
  const callbacks = useRef(options)
  callbacks.current = options
  const board = useRef<RawLiveQuerySubscription<BoardTile> | null>(null)
  const restart = useRef<() => void>(() => {})
  useEffect(() => {
    let stopped = false
    let cleanupConnection = () => {}
    let retry: ReturnType<typeof setTimeout> | undefined
    const bootstrap = async (): Promise<Bootstrap> => {
      const response = await fetch("/api/realtime", { cache: "no-store" })
      if (!response.ok) throw new Error("Could not obtain a Realtime query")
      return response.json()
    }
    const report = (error: unknown) =>
      callbacks.current.onError(error instanceof Error ? error : new Error(String(error)))
    const connect = async () => {
      cleanupConnection()
      callbacks.current.onDisconnected()
      try {
        const bootstrapStarted = performance.now()
        const initial = await bootstrap()
        if (stopped) return
        console.info("[Board Realtime] Bootstrap ready", {
          elapsedMs: Math.round(performance.now() - bootstrapStarted),
        })
        callbacks.current.onGameStartTimestamp(initial.startedAt)
        const subscribedAt = performance.now()
        const elapsedMs = () => Math.round(performance.now() - subscribedAt)
        // Use SDK lifecycle diagnostics without logging query capabilities or rows.
        const client = createRealtimeClient({
          url: initial.url,
          logLevel: "debug",
          logger: (entry) => {
            if (
              entry.event === "connection_ready" ||
              entry.event === "subscription_admitted" ||
              entry.event === "subscription_baseline_sync_started" ||
              entry.event === "subscription_baseline_sync_completed"
            ) {
              console.info(`[Board Realtime] ${entry.event}`, {
                elapsedMs: elapsedMs(),
                subscriptionId: "subscriptionId" in entry ? entry.subscriptionId : undefined,
              })
            } else if (entry.level === "error" || entry.level === "warn") {
              console.warn(`[Board Realtime] ${entry.event}`, {
                elapsedMs: elapsedMs(),
                code: "code" in entry ? entry.code : undefined,
                subscriptionId: "subscriptionId" in entry ? entry.subscriptionId : undefined,
                message: entry.message,
              })
            }
          },
        })
        console.info("[Board Realtime] Subscribe called", { elapsedMs: 0 })
        const sub = client.subscribe(initial.query, { materialize: false })
        const meta = client.subscribe(initial.gameQuery, { materialize: false })
        board.current = sub
        const refresh = new QueryRefreshController({
          query: initial.query,
          subscription: sub,
          refreshQuery: async () => (await bootstrap()).query,
          renewSubscription: (query) => sub.renew(query),
          onRefreshExhausted: (error) => {
            report(error)
            scheduleReconnect()
          },
        })
        const metaRefresh = new QueryRefreshController({
          query: initial.gameQuery,
          subscription: meta,
          refreshQuery: async () => (await bootstrap()).gameQuery,
          renewSubscription: (query) => meta.renew(query),
          onRefreshExhausted: (error) => {
            report(error)
            scheduleReconnect()
          },
        })
        cleanupConnection = () => {
          if (updateLog) clearTimeout(updateLog)
          refresh.stop()
          metaRefresh.stop()
          client.close()
          board.current = null
        }
        // Aggregate updates once per second to keep busy games' consoles usable.
        let updateLog: ReturnType<typeof setTimeout> | undefined
        let updateRows = 0,
          updatePackedKB = 0,
          updateProtocolKB = 0
        sub.onReset((rows) => {
          try {
            if (rows.length !== TILE_COUNT) throw new Error("Incomplete board snapshot")
            const receivedAt = performance.now()
            const receivedMs = elapsedMs()
            callbacks.current.onTiles(
              rows.map((item) => item.row),
              true,
            )
            const appliedAt = performance.now()
            console.info("[Board Realtime] Game state loaded", {
              receivedMs,
              appliedMs: Math.round(appliedAt - subscribedAt),
              applyDurationMs: Math.round(appliedAt - receivedAt),
              ...boardPayloadSize(rows),
            })
          } catch (error) {
            report(error)
            scheduleReconnect()
          }
        })
        sub.onBatch((changes) => {
          try {
            const tiles = changes.map((change) => {
              if (change.type !== "upsert") throw new Error("A board tile was removed")
              return change.row
            })
            callbacks.current.onTiles(tiles, false)
            const size = boardPayloadSize(changes.filter((change) => change.type === "upsert"))
            updateRows += size.rows
            updatePackedKB += size.packedKB
            updateProtocolKB += size.protocolRowsKB
            updateLog ??= setTimeout(() => {
              console.info("[Board Realtime] Updates received", {
                elapsedMs: elapsedMs(),
                rows: updateRows,
                packedKB: Number(updatePackedKB.toFixed(3)),
                protocolRowsKB: Number(updateProtocolKB.toFixed(3)),
              })
              updateRows = updatePackedKB = updateProtocolKB = 0
              updateLog = undefined
            }, 1000)
          } catch (error) {
            report(error)
            scheduleReconnect()
          }
        })
        sub.onStateChange((state) => {
          if (state.status === "live") callbacks.current.onConnected()
          else callbacks.current.onDisconnected()
          if (state.error) {
            report(state.error)
            scheduleReconnect()
          }
        })
        const reportStart = (row: { started_at: number | string }) =>
          callbacks.current.onGameStartTimestamp(Number(row.started_at))
        meta.onReset((rows) => {
          for (const item of rows) reportStart(item.row)
        })
        meta.onBatch((changes) => {
          for (const change of changes) if (change.type === "upsert") reportStart(change.row)
        })
        meta.onStateChange((state) => {
          if (state.error) {
            report(state.error)
            scheduleReconnect()
          }
        })
        refresh.start()
        metaRefresh.start()
      } catch (error) {
        if (!stopped) {
          report(error)
          scheduleReconnect()
        }
      }
    }
    function scheduleReconnect() {
      if (stopped || retry) return
      retry = setTimeout(() => {
        retry = undefined
        void connect()
      }, 1500)
    }
    restart.current = scheduleReconnect
    void connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      cleanupConnection()
    }
  }, [])

  const awaitTxId = useCallback(async (txid: string) => {
    const sub = board.current
    if (!sub) throw new Error("Realtime is reconnecting")
    await sub.awaitTxId(txid, 15000)
  }, [])
  return { awaitTxId, reconnect: () => restart.current() }
}
