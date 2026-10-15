import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { createRealtimeClient, QueryRefreshController } from "@neon/realtime/client"
import type { RawLiveQuerySubscription, SealedLiveQuery } from "@neon/realtime/client"
import { GameState } from "../shared/game-state"
import {
  GAME_END_MODE,
  FIRST_TO_SCORE_TARGET,
  TOTAL_BOX_COUNT,
  GRID_WIDTH,
  GRID_HEIGHT,
} from "../shared/game-config"
import { boxCoordsToId, coordsToEdgeId, getBoxEdges } from "../shared/edge-math"
import {
  boxLocation,
  edgeLocation,
  getOwner,
  setOwner,
  TILE_COUNT,
  TILE_SIZE,
} from "../shared/tiles"
import type { BoardTile } from "../shared/tiles"
import { GameStore } from "../server/store"
import { createIdentityCookie } from "../server/lib/identity-cookie"
import { eventually, startTestStack } from "./test-stack"

const stack = await startTestStack()
const pool = new pg.Pool({ connectionString: stack.databaseUrl })
const store = new GameStore(pool)
interface Observer {
  rows: Map<number, BoardTile>
  batches: { tileIds: number[]; txids: readonly string[] }[]
  sub: RawLiveQuerySubscription<BoardTile>
  resets: () => number
  renewals: () => number
  check: () => void
  close: () => void
}
const observers: Observer[] = []
const oracle = new GameState()
let resetMetadataClient: ReturnType<typeof createRealtimeClient> | undefined

async function bootstrap(): Promise<{
  startedAt: number
  query: SealedLiveQuery<BoardTile>
  gameQuery: SealedLiveQuery<{ started_at: number | string }>
}> {
  const response = await fetch(`${stack.apiUrl}/api/realtime`)
  assert(response.ok)
  return response.json()
}
async function observe(): Promise<Observer> {
  const initial = await bootstrap()
  const client = createRealtimeClient({ url: stack.realtimeUrl })
  const sub = client.subscribe(initial.query, { materialize: false })
  const rows = new Map<number, BoardTile>()
  const batches: { tileIds: number[]; txids: readonly string[] }[] = []
  let resets = 0,
    renewals = 0,
    fatal: unknown
  const refresh = new QueryRefreshController({
    query: initial.query,
    subscription: sub,
    refreshQuery: async () => (await bootstrap()).query,
    renewSubscription: (query) => sub.renew(query),
    onSubscriptionRenewed: () => {
      renewals++
    },
    onRefreshExhausted: (error) => {
      fatal = error
    },
  })
  sub.onStateChange((state) => {
    if (state.error)
      console.log(`Subscriber state: ${state.status}, ${state.error.code}: ${state.error.message}`)
    if (state.error && !state.error.retryable) fatal = state.error
  })
  sub.onReset((reset) => {
    rows.clear()
    for (const item of reset) rows.set(item.row.tile_id, item.row)
    resets++
  })
  sub.onBatch((changes, batch) => {
    const tileIds: number[] = []
    for (const change of changes) {
      assert.equal(change.type, "upsert")
      if (change.type === "upsert") {
        rows.set(change.row.tile_id, change.row)
        tileIds.push(change.row.tile_id)
      }
    }
    if (tileIds.length) batches.push({ tileIds, txids: batch.txids })
  })
  refresh.start()
  const observer = {
    rows,
    batches,
    sub,
    resets: () => resets,
    renewals: () => renewals,
    check: () => {
      if (fatal) throw fatal
    },
    close: () => {
      refresh.stop()
      client.close()
    },
  }
  observers.push(observer)
  await eventually(() => {
    observer.check()
    return rows.size === TILE_COUNT && sub.getState().status === "live"
  }, "full board snapshot")
  return observer
}
async function identity(teamId: number) {
  const playerId = randomUUID()
  return {
    playerId,
    cookie: `boxes_identity=${await createIdentityCookie(playerId, teamId, stack.identitySecret)}`,
    teamId,
  }
}
async function draw(player: Awaited<ReturnType<typeof identity>>, edgeId: number) {
  const response = await fetch(`${stack.apiUrl}/api/draw`, {
    method: "POST",
    headers: { cookie: player.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ edgeId }),
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, ...(await response.json()) }
}
async function accepted(player: Awaited<ReturnType<typeof identity>>, edgeId: number) {
  return confirm(player, edgeId, await draw(player, edgeId))
}
async function confirm(
  player: Awaited<ReturnType<typeof identity>>,
  edgeId: number,
  result: Awaited<ReturnType<typeof draw>>,
) {
  assert.equal(result.status, 200, JSON.stringify(result))
  oracle.applyEvent({ edgeId, teamId: player.teamId })
  await Promise.all(
    observers.map(async (observer, index) => {
      observer.check()
      try {
        await observer.sub.awaitTxId(result.txid, 15000)
      } catch (error) {
        console.log({
          edgeId,
          subscriber: index,
          state: observer.sub.getState(),
          resets: observer.resets(),
          renewals: observer.renewals(),
        })
        throw error
      }
    }),
  )
  return result
}
async function lockTile(tileId: number) {
  const db = await pool.connect()
  await db.query("BEGIN")
  await db.query("SELECT tile_id FROM board_tiles WHERE game_id = 1 AND tile_id = $1 FOR UPDATE", [
    tileId,
  ])
  const {
    rows: [{ pid }],
  } = await db.query("SELECT pg_backend_pid() AS pid")
  let released = false
  return {
    waitForMove: () =>
      eventually(async () => {
        const {
          rows: [row],
        } = await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
          [pid],
        )
        return row.blocked
      }, "draw waiting for a tile lock"),
    release: async () => {
      if (!released) {
        released = true
        await db.query("ROLLBACK")
        db.release()
      }
    },
  }
}
async function compare() {
  const { rows } = await pool.query<BoardTile>(
    "SELECT tile_id, revision, edges, boxes FROM board_tiles WHERE game_id = 1",
  )
  for (const observer of observers) {
    observer.check()
    assert.equal(observer.rows.size, TILE_COUNT)
    const state = new GameState()
    for (const row of rows) {
      const received = observer.rows.get(row.tile_id)!
      assert.equal(received.revision, row.revision)
      assert.deepEqual(Buffer.from(received.edges), row.edges)
      assert.deepEqual(Buffer.from(received.boxes), row.boxes)
      state.applyTile(received)
    }
    assert.equal(state.getEdgesPlacedCount(), oracle.getEdgesPlacedCount())
    assert.deepEqual(state.getScores(), oracle.getScores())
  }
  const game = await store.game()
  assert.equal(game.edges_placed, oracle.getEdgesPlacedCount())
  assert.deepEqual(game.scores, oracle.getScores())
}

try {
  // Check the SQL port against the browser codec, including seams and all outer edges.
  const positions = [
    ...Array.from({ length: 17 }, (_, i) => i),
    ...Array.from({ length: 9 }, (_, i) => 992 + i),
  ]
  const samples = []
  for (const x of positions)
    for (const y of positions)
      for (const horizontal of [true, false]) {
        if (horizontal ? x >= GRID_WIDTH || y > GRID_HEIGHT : x > GRID_WIDTH || y >= GRID_HEIGHT)
          continue
        const edgeId = coordsToEdgeId(x, y, horizontal),
          location = edgeLocation(edgeId)
        samples.push({ edge_id: edgeId, tile_id: location.tileId, owner_index: location.index })
      }
  const locations = await pool.query(
    `SELECT sample.edge_id FROM jsonb_to_recordset($1::jsonb)
    AS sample(edge_id integer, tile_id integer, owner_index integer)
    CROSS JOIN LATERAL boxes_edge_location(sample.edge_id, $2, $3, $4) AS location
    WHERE location.tile_id IS DISTINCT FROM sample.tile_id OR location.owner_index IS DISTINCT FROM sample.owner_index`,
    [JSON.stringify(samples), GRID_WIDTH, GRID_HEIGHT, TILE_SIZE],
  )
  assert.deepEqual(locations.rows, [])
  const packed = new Uint8Array(54)
  for (let i = 0; i < 144; i++) setOwner(packed, i, i % 5)
  const owners = await pool.query<{ owner_index: number; owner: number; changed: Buffer }>(
    `SELECT n AS owner_index,
    boxes_owner($1::bytea, n) AS owner, boxes_set_owner($1::bytea, n, (n + 1) % 5) AS changed
    FROM generate_series(0, 143) AS n`,
    [Buffer.from(packed)],
  )
  for (const row of owners.rows) {
    assert.equal(row.owner, getOwner(packed, row.owner_index))
    const expected = packed.slice()
    setOwner(expected, row.owner_index, (row.owner_index + 1) % 5)
    assert.deepEqual(row.changed, Buffer.from(expected))
  }
  console.log(
    `SQL/browser codec parity passed for ${samples.length} edge locations and 144 packed owners.`,
  )

  console.log(
    "Starting two full-board subscribers against disposable Postgres, proxy and game API...",
  )
  const first = await observe(),
    second = await observe()
  assert.equal(
    [...first.rows.values()].reduce((sum, tile) => sum + tile.edges.length + tile.boxes.length, 0),
    1125750,
  )
  const noIdentity = await fetch(`${stack.apiUrl}/api/draw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"edgeId":0}',
  })
  assert.equal(noIdentity.status, 401)
  const player = await identity(1)
  let drawCalls = 0
  const countingPool = new Proxy(pool, {
    get(target, property) {
      if (property === "query")
        return (...args: unknown[]) => {
          drawCalls++
          return Reflect.apply(target.query, target, args)
        }
      if (property === "connect")
        return () => {
          throw new Error("Draw must not open an interactive transaction")
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const oneCallPlayer = await identity(3),
    oneCallEdge = coordsToEdgeId(320, 320, true)
  await confirm(
    oneCallPlayer,
    oneCallEdge,
    await new GameStore(countingPool).draw(oneCallPlayer, oneCallEdge),
  )
  assert.equal(drawCalls, 1, "draw uses exactly one autocommit database call")
  const shared = coordsToEdgeId(8, 7, false)
  const preparation = [...new Set([...getBoxEdges(7, 7), ...getBoxEdges(8, 7)])].filter(
    (id) => id !== shared,
  )
  for (const edge of preparation) await accepted(player, edge)
  const finish = await accepted(player, shared)
  assert.equal(finish.boxesClaimed, 2)
  assert.equal(finish.quotaRemaining, 5)
  for (const observer of [first, second]) {
    const batch = observer.batches.find((batch) => batch.txids.includes(finish.txid))!
    assert.deepEqual(
      batch.tileIds.sort((a, b) => a - b),
      [0, 1],
    )
    for (const x of [7, 8]) {
      const location = boxLocation(x, 7)
      assert.equal(getOwner(observer.rows.get(location.tileId)!.boxes, location.index), 2)
    }
    assert.equal(observer.resets(), 1, "normal draws remain incremental")
  }
  await compare()
  console.log(
    "Cross-tile double claim is atomic in both clients; explicit owners, scores and bonus match Postgres.",
  )

  const competitor = await identity(2),
    raceEdge = coordsToEdgeId(40, 40, true)
  const race = await Promise.all([draw(player, raceEdge), draw(competitor, raceEdge)])
  assert.deepEqual(race.map((result) => result.status).sort(), [200, 409])
  const winner = race[0].ok ? player : competitor
  oracle.applyEvent({ edgeId: raceEdge, teamId: winner.teamId })
  const success = race.find((result) => result.ok)!
  await Promise.all(observers.map((observer) => observer.sub.awaitTxId(success.txid, 15000)))
  const beforeDuplicate = (await store.quota(winner.playerId)).quotaRemaining
  assert.equal((await draw(winner, raceEdge)).status, 409)
  assert.equal((await store.quota(winner.playerId)).quotaRemaining, beforeDuplicate)
  const rejectedFirstPlayer = await identity(0)
  assert.equal((await draw(rejectedFirstPlayer, raceEdge)).status, 409)
  const rejectedQuota = await pool.query(
    "SELECT player_id FROM player_quotas WHERE player_id = $1",
    [rejectedFirstPlayer.playerId],
  )
  assert.equal(rejectedQuota.rowCount, 0, "a rejected first move rolls back quota creation")
  assert.equal((await draw(player, 2002000)).status, 400)

  // An externally held tile lock must block local moves, not distant ones.
  const blockedPlayer = await identity(0),
    freePlayer = await identity(3)
  for (const blockedEdge of [coordsToEdgeId(2, 2, true), coordsToEdgeId(8, 3, false)]) {
    const lock = await lockTile(0)
    try {
      let settled = false
      const pending = draw(blockedPlayer, blockedEdge).finally(() => {
        settled = true
      })
      await lock.waitForMove()
      await accepted(
        freePlayer,
        coordsToEdgeId(240, blockedEdge === coordsToEdgeId(2, 2, true) ? 240 : 248, true),
      )
      assert.equal(settled, false, "distant moves commit while the tile move waits")
      await lock.release()
      await confirm(blockedPlayer, blockedEdge, await pending)
    } finally {
      await lock.release()
    }
  }
  await compare()
  console.log("Tile contention is local; a boundary edge also locks the adjacent tile.")

  // Two moves need the same four corner tiles in different discovery orders.
  const corner = { x: 607, y: 607 }
  const cornerEdges = [coordsToEdgeId(608, 607, false), coordsToEdgeId(607, 608, true)]
  for (const edge of getBoxEdges(corner.x, corner.y).filter((edge) => !cornerEdges.includes(edge)))
    await accepted(freePlayer, edge)
  const cornerPlayers = [await identity(1), await identity(2)]
  const cornerResults = await Promise.all(
    cornerEdges.map((edge, index) => draw(cornerPlayers[index], edge)),
  )
  assert.deepEqual(
    cornerResults.map((result) => result.status),
    [200, 200],
  )
  assert.deepEqual(cornerResults.map((result) => result.boxesClaimed).sort(), [0, 1])
  for (const index of [0, 1].sort(
    (a, b) => cornerResults[a].boxesClaimed - cornerResults[b].boxesClaimed,
  ))
    await confirm(cornerPlayers[index], cornerEdges[index], cornerResults[index])
  await compare()

  // First-ever concurrent moves from one player must not create independent buckets.
  const concurrentPlayer = await identity(0)
  const concurrentEdges = Array.from({ length: 9 }, (_, i) =>
    coordsToEdgeId(720 + i * 16, 720, true),
  )
  const concurrentResults = await Promise.all(
    concurrentEdges.map((edge) => draw(concurrentPlayer, edge)),
  )
  assert.equal(concurrentResults.filter((result) => result.status === 200).length, 8)
  assert.equal(concurrentResults.filter((result) => result.status === 429).length, 1)
  for (let i = 0; i < concurrentResults.length; i++)
    if (concurrentResults[i].ok)
      await confirm(concurrentPlayer, concurrentEdges[i], concurrentResults[i])

  // Independent tile claims still increment the shared team counters atomically.
  const claims = []
  for (let i = 0; i < 8; i++) {
    const claimant = await identity(i % 4),
      edges = getBoxEdges(500 + i * 16, 504)
    for (const edge of edges.slice(0, 3)) await accepted(claimant, edge)
    claims.push({ claimant, edge: edges[3] })
  }
  const claimResults = await Promise.all(claims.map(({ claimant, edge }) => draw(claimant, edge)))
  for (let i = 0; i < claims.length; i++) {
    assert.equal(claimResults[i].boxesClaimed, 1)
    await confirm(claims[i].claimant, claims[i].edge, claimResults[i])
  }
  await compare()
  console.log(
    "Corner lock ordering, concurrent first-player quota and independent score increments passed.",
  )

  // Both moves see an unfinished game, but only one can make the final claim.
  const lastClaims = []
  for (const x of [880, 896]) {
    const claimant = await identity(0),
      edges = getBoxEdges(x + 2, 882)
    for (const edge of edges.slice(0, 3)) await accepted(claimant, edge)
    lastClaims.push({ claimant, edge: edges[3] })
  }
  const target = GAME_END_MODE === "board_complete" ? TOTAL_BOX_COUNT : FIRST_TO_SCORE_TARGET
  await pool.query("UPDATE games SET scores = ARRAY[$1::integer,0,0,0] WHERE game_id = 1", [
    target - 1,
  ])
  const lastLocks = await Promise.all(
    lastClaims.map(({ edge }) => lockTile(edgeLocation(edge).tileId)),
  )
  try {
    const pending = lastClaims.map(({ claimant, edge }) => draw(claimant, edge))
    await Promise.all(lastLocks.map((lock) => lock.waitForMove()))
    await Promise.all(lastLocks.map((lock) => lock.release()))
    const results = await Promise.all(pending)
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 410])
    const winnerIndex = results.findIndex((result) => result.ok),
      loserIndex = 1 - winnerIndex
    await confirm(
      lastClaims[winnerIndex].claimant,
      lastClaims[winnerIndex].edge,
      results[winnerIndex],
    )
    assert.equal(
      results[loserIndex].quotaRemaining,
      5,
      "rejection returns the quota before the rolled-back move",
    )
    assert.equal((await store.quota(lastClaims[loserIndex].claimant.playerId)).quotaRemaining, 5)
    assert.equal((await store.game()).complete, true)
  } finally {
    await Promise.all(lastLocks.map((lock) => lock.release()))
    await pool.query("UPDATE games SET scores = $1, complete = false WHERE game_id = 1", [
      oracle.getScores(),
    ])
  }
  await compare()
  console.log("Concurrent game-ending claim rolls back the losing tile and quota changes.")

  const limited = await identity(0)
  for (let i = 0; i < 8; i++) await accepted(limited, coordsToEdgeId(100 + i * 2, 100, true))
  const ninth = coordsToEdgeId(120, 100, true),
    ninthLocation = edgeLocation(ninth)
  const revision = first.rows.get(ninthLocation.tileId)!.revision
  assert.equal((await draw(limited, ninth)).status, 429)
  assert.equal(first.rows.get(ninthLocation.tileId)!.revision, revision)
  await pool.query("UPDATE player_quotas SET last_refill_at = $1 WHERE player_id = $2", [
    Date.now() - 3000,
    limited.playerId,
  ])
  assert.equal((await accepted(limited, ninth)).quotaRemaining, 0)

  // Fail the same statement after the stored function wrote tiles/game/quota.
  // The dependency on its returned result prevents an early constant-folded error.
  const rollbackPlayer = await identity(3),
    rollbackEdge = coordsToEdgeId(300, 300, true)
  const failingPool = new Proxy(pool, {
    get(target, property) {
      if (property === "query")
        return (sql: string, parameters: unknown[]) =>
          target.query(
            `WITH move AS MATERIALIZED (${sql}) SELECT result,
        1 / ((result->>'quotaRemaining')::integer * 0) AS injected_failure FROM move`,
            parameters,
          )
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  await assert.rejects(
    new GameStore(failingPool).draw(rollbackPlayer, rollbackEdge),
    /division by zero/,
  )
  assert.equal((await store.quota(rollbackPlayer.playerId)).quotaRemaining, 8)
  await compare()
  await accepted(rollbackPlayer, rollbackEdge)
  for (const edge of getBoxEdges(999, 999)) await accepted(rollbackPlayer, edge)
  assert.equal(oracle.getBoxOwner(boxCoordsToId(999, 999)), 4)
  await observe()
  await compare()
  console.log(
    "Concurrent duplicate, quota exhaustion/refill, rollback, outer edges and late join all passed.",
  )

  if (!process.argv.includes("--quick")) {
    console.log("Checking capability renewal beyond the original 60-second expiry...")
    const deadline = Date.now() + 65000
    await eventually(
      () => {
        observers.forEach((observer) => observer.check())
        return Date.now() >= deadline
      },
      "renewal window",
      70000,
    )
    observers.forEach((observer) => assert(observer.renewals() > 0))
    await accepted(competitor, coordsToEdgeId(400, 400, true))
    console.log("Post-expiry write confirmed.")
  }
  console.log("Restarting proxy...")
  const previousResets = new Map(observers.map((observer) => [observer, observer.resets()]))
  await stack.restartProxy()
  // A backend rejection terminates an SDK subscription. Like the browser hook,
  // replace that subscription and obtain a new authoritative snapshot.
  await eventually(
    () =>
      observers.every(
        (observer) =>
          observer.sub.getState().status === "error" ||
          (observer.sub.getState().status === "live" &&
            observer.resets() > previousResets.get(observer)!),
      ),
    "proxy readmission",
  )
  for (const observer of [...observers]) {
    if (observer.sub.getState().status !== "error") continue
    assert.equal(observer.sub.getState().error?.code, "upstream_rejected")
    observer.close()
    observers.splice(observers.indexOf(observer), 1)
    await observe()
  }
  await accepted(competitor, coordsToEdgeId(410, 410, true))
  await eventually(
    () => observers.every((observer) => observer.sub.getState().status === "live"),
    "proxy recovery",
  )
  await compare()
  console.log("Proxy restart recovered; committed writes match all three subscribers.")

  // The browser reloads on this metadata change. Follow that same reset path:
  // stop the old game subscriptions and install fresh authoritative snapshots.
  const beforeReset = (await store.game()).started_at
  let startedAt = beforeReset
  resetMetadataClient = createRealtimeClient({ url: stack.realtimeUrl })
  const metadata = resetMetadataClient.subscribe((await bootstrap()).gameQuery, {
    materialize: false,
  })
  metadata.onReset((rows) => {
    for (const item of rows) startedAt = Number(item.row.started_at)
  })
  metadata.onBatch((changes) => {
    for (const change of changes)
      if (change.type === "upsert") startedAt = Number(change.row.started_at)
  })
  await eventually(() => metadata.getState().status === "live", "reset metadata subscription")
  // Reset must wait for an active tile-scoped move, which can still finish.
  const resetBlocker = await lockTile(boxLocation(904, 904).tileId)
  try {
    const pending = draw(await identity(3), coordsToEdgeId(906, 906, true))
    await resetBlocker.waitForMove()
    let resetFinished = false
    const resetting = store.reset().finally(() => {
      resetFinished = true
    })
    await eventually(async () => {
      const {
        rows: [row],
      } = await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE query = 'SELECT game_id FROM games WHERE game_id = 1 FOR UPDATE'
          AND wait_event_type = 'Lock') AS blocked`)
      return row.blocked
    }, "reset waiting for the active move")
    assert.equal(resetFinished, false)
    await resetBlocker.release()
    assert.equal((await pending).status, 200)
    await resetting
  } finally {
    await resetBlocker.release()
  }
  await eventually(async () => {
    if (startedAt > beforeReset) return true
    // A bulk reset can end the board subscription in this development backend.
    // The hook reconnects and checks the timestamp from /api/realtime as well.
    if (
      metadata.getState().status === "error" ||
      observers.some((observer) => observer.sub.getState().status === "error")
    ) {
      startedAt = (await bootstrap()).startedAt
    }
    return startedAt > beforeReset
  }, "game reset notification/reconnect")
  observers.forEach((observer) => observer.close())
  observers.length = 0
  await observe()
  await observe()
  await observe()
  for (const observer of observers)
    for (const tile of observer.rows.values()) {
      assert(tile.edges.every((byte) => byte === 0) && tile.boxes.every((byte) => byte === 0))
    }
  const resetGame = await store.game()
  assert.equal(resetGame.edges_placed, 0)
  assert.deepEqual(resetGame.scores, [0, 0, 0, 0])
  assert.equal((await store.quota(player.playerId)).quotaRemaining, 8)
  console.log(
    `PASS: full-board snapshots, incremental fan-out, game rules, write confirmation, ${process.argv.includes("--quick") ? "" : "renewal, "}reconnect and reset.`,
  )
} finally {
  observers.forEach((observer) => observer.close())
  resetMetadataClient?.close()
  await pool.end()
  await stack.stop()
}
