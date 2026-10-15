import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { loadEnvFile } from "node:process"
import pg from "pg"
import { GameStore } from "../server/store"
import { seedBoard } from "./seed-board"
import { EDGE_COUNT, W, H, getBoxEdges } from "../shared/edge-math"
import { getOwner, visitTileEdges } from "../shared/tiles"
import type { Identity } from "../server/lib/identity-cookie"

const { values } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    moves: { type: "string", default: "120" },
    rate: { type: "string", default: "2" },
    players: { type: "string", default: "512" },
    seed: { type: "string", default: "1" },
    complete: { type: "string" },
    help: { type: "boolean", default: false },
  },
})
if (values.help) {
  console.log(`Usage: pnpm simulate [--local] [--moves 120] [--rate 2] [--players 512] [--seed 1]
       pnpm simulate [--local] --complete 90 [--seed 1]
Adds play without resetting the board. Rate is successful moves/second; 0 runs unpaced.
--complete bulk-seeds to a percentage of completed boxes, briefly locking draws.
--local uses the running local development database; otherwise configure DATABASE_URL.
Uses the real Postgres draw function and quotas, with four teams playing in patches.
Stop safely with Ctrl+C. Each move commits separately.`)
  process.exit(0)
}
function integer(name: "moves" | "rate" | "players" | "seed", minimum: number, maximum: number) {
  const value = Number(values[name])
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`)
  return value
}
const moves = integer("moves", 1, EDGE_COUNT)
const rate = integer("rate", 0, 10000)
const playerCount = integer("players", 4, 10000)
let seed = integer("seed", 0, 0xffffffff)

let databaseUrl: string | undefined
if (values.local) {
  const runtime = JSON.parse(
    await readFile(new URL("../.local/dev/runtime.json", import.meta.url), "utf8"),
  )
  databaseUrl = runtime.DATABASE_URL
  if (!databaseUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname))
    throw new Error("The local runtime must point to a loopback database")
} else {
  try {
    loadEnvFile(new URL("../.env", import.meta.url))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error("Configure DATABASE_URL, or use --local for the local dev stack")
}

/** Repeatable patch placement and team selection for visual comparisons. */
function random() {
  seed = (seed + 0x6d2b79f5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
if (values.complete !== undefined) {
  const percent = Number(values.complete)
  try {
    if (!Number.isInteger(percent) || percent < 1 || percent > 100)
      throw new Error("--complete must be an integer between 1 and 100")
    await seedBoard(pool, percent, random)
  } finally {
    await pool.end()
  }
  process.exit(0)
}
const store = new GameStore(pool)
const players: Array<{ identity: Identity; readyAt: number }> = Array.from(
  { length: playerCount },
  (_, index) => ({ identity: { playerId: randomUUID(), teamId: index % 4 }, readyAt: 0 }),
)
let stopping = false
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true
  })

try {
  // Read existing owners once to avoid wasting moves on established areas.
  // Every write still goes through boxes_draw, which resolves races with humans.
  const taken = new Uint8Array(EDGE_COUNT)
  const { rows } = await pool.query<{ tile_id: number; edges: Buffer }>(
    "SELECT tile_id, edges FROM board_tiles WHERE game_id = 1",
  )
  if (rows.length === 0) throw new Error("Run pnpm db:init first to initialize the game")
  for (const tile of rows)
    visitTileEdges(tile.tile_id, (edgeId, index) => {
      taken[edgeId] = getOwner(tile.edges, index) > 0 ? 1 : 0
    })
  const available = taken.reduce((sum, owner) => sum + (owner === 0 ? 1 : 0), 0)
  const target = Math.min(moves, available)
  console.log(
    `Adding up to ${target.toLocaleString()} moves with ${playerCount} players (${rate ? `${rate}/s` : "unpaced"}).`,
  )
  let placed = 0,
    boxes = 0,
    cursor = 0,
    patch = 0,
    misses = 0
  const started = performance.now()
  let reportAt = started
  while (!stopping && placed < target) {
    // Begin around the default viewport, then distribute visible pockets of play
    // across the whole map. Partial patches leave opportunities for human claims.
    const size = patch === 0 ? 24 : 16 + Math.floor(random() * 33)
    const x = patch === 0 ? W / 2 - size / 2 : Math.floor(random() * (W - size + 1))
    const y = patch === 0 ? H / 2 - size / 2 : Math.floor(random() * (H - size + 1))
    const candidates = new Set<number>()
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++)
        if (random() < (patch === 0 ? 0.45 : 0.65)) {
          const edges = getBoxEdges(x + col, y + row)
          // Randomize the closing edge without losing the local shape of play.
          for (let i = edges.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1))
            ;[edges[i], edges[j]] = [edges[j], edges[i]]
          }
          for (const edgeId of edges) if (!taken[edgeId]) candidates.add(edgeId)
        }
    patch++
    if (candidates.size === 0) {
      // Avoid looping forever on a nearly complete board.
      if (++misses > 1000) break
      continue
    }
    misses = 0
    for (const edgeId of candidates) {
      if (stopping || placed >= target) break
      if (rate > 0) {
        const wait = started + (placed * 1000) / rate - performance.now()
        if (wait > 0) await delay(wait)
        if (stopping) break
      }
      let player = players[cursor++ % players.length]
      // Honor real token buckets rather than disabling quotas for bots.
      while (!stopping && player.readyAt > Date.now()) {
        const ready = players.find((candidate) => candidate.readyAt <= Date.now())
        if (ready) {
          player = ready
          break
        }
        await delay(
          Math.min(100, Math.max(1, Math.min(...players.map((p) => p.readyAt)) - Date.now())),
        )
      }
      if (stopping) break
      const result = await store.draw(player.identity, edgeId)
      if (result.ok) {
        taken[edgeId] = 1
        placed++
        boxes += result.boxesClaimed ?? 0
        if (result.quotaRemaining === 0) player.readyAt = Date.now() + (result.refillIn ?? 3) * 1000
      } else if (result.code === "QUOTA_EXHAUSTED") {
        player.readyAt = Date.now() + Math.max(50, (result.refillIn ?? 3) * 1000)
      } else if (result.code === "EDGE_TAKEN") {
        taken[edgeId] = 1
      } else if (result.code === "GAME_COMPLETE") {
        stopping = true
      } else {
        throw new Error(`Simulation move failed: ${result.code}`)
      }
      const now = performance.now()
      if (now - reportAt >= 2000) {
        console.log(
          `${placed.toLocaleString()} moves, ${boxes.toLocaleString()} boxes (${Math.round((placed * 1000) / (now - started))}/s).`,
        )
        reportAt = now
      }
    }
  }
  console.log(
    `Finished: ${placed.toLocaleString()} moves, ${boxes.toLocaleString()} boxes in ${((performance.now() - started) / 1000).toFixed(1)}s.`,
  )
  const game = await store.game()
  console.log(
    `Board: ${Number(game.edges_placed).toLocaleString()} edges; team scores ${game.scores.join(", ")}.`,
  )
} finally {
  await pool.end()
}
