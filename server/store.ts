import { readFile } from "node:fs/promises"
import type { Pool } from "pg"
import { TILE_COUNT, TILE_SIZE } from "../shared/tiles.js"
import { isValidEdgeId } from "../shared/edge-math.js"
import {
  FIRST_TO_SCORE_TARGET,
  GAME_END_MODE,
  GRID_WIDTH,
  GRID_HEIGHT,
  MAX_QUOTA,
  QUOTA_REFILL_INTERVAL_MS,
  QUOTA_TIMING_LEEWAY_MS,
  QUOTA_BONUS_SINGLE,
  QUOTA_BONUS_DOUBLE,
} from "../shared/game-config.js"
import type { Identity } from "./lib/identity-cookie.js"

export const BOARD_QUERY =
  "SELECT tile_id, revision, edges, boxes FROM board_tiles WHERE game_id = $1"
export const GAME_QUERY = "SELECT started_at FROM games WHERE game_id = $1"

// Supplied by the server, never taken from the HTTP request.
const DRAW_RULES = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  tileSize: TILE_SIZE,
  maxQuota: MAX_QUOTA,
  refillIntervalMs: QUOTA_REFILL_INTERVAL_MS,
  leewayMs: QUOTA_TIMING_LEEWAY_MS,
  bonusSingle: QUOTA_BONUS_SINGLE,
  bonusDouble: QUOTA_BONUS_DOUBLE,
  endMode: GAME_END_MODE,
  scoreTarget: FIRST_TO_SCORE_TARGET,
}

export interface DrawResult {
  status: 200 | 400 | 409 | 410 | 429
  ok: boolean
  code?: string
  txid?: string
  boxesClaimed?: number
  quotaRemaining?: number
  refillIn?: number
}

type QuotaRow = { tokens: number; last_refill_at: string }

export function refillQuota(row: QuotaRow | undefined, now: number, leeway = 0) {
  // Read-only projection for /api/quota. boxes_draw independently enforces the
  // same rules using Postgres's clock after it has acquired the move locks.
  if (!row) return { tokens: MAX_QUOTA, lastRefillAt: now }
  const previous = Number(row.last_refill_at)
  const refills = Math.max(0, Math.floor((now - previous + leeway) / QUOTA_REFILL_INTERVAL_MS))
  const tokens = Math.min(MAX_QUOTA, row.tokens + refills)
  return {
    tokens,
    lastRefillAt: tokens === MAX_QUOTA ? now : previous + refills * QUOTA_REFILL_INTERVAL_MS,
  }
}

export class GameStore {
  constructor(readonly pool: Pool) {}

  async initialize(): Promise<void> {
    // Install the schema/functions and seed missing tiles without resetting an
    // existing game. Run via db:init, outside the application startup and request paths.
    const db = await this.pool.connect()
    try {
      await db.query("BEGIN")
      await db.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"))
      await db.query(await readFile(new URL("./draw.sql", import.meta.url), "utf8"))
      await db.query(
        "INSERT INTO games(game_id, started_at) VALUES(1, $1) ON CONFLICT DO NOTHING",
        [Date.now()],
      )
      await db.query("SELECT game_id FROM games WHERE game_id = 1 FOR UPDATE")
      // Capacity can change while developing game rules. Clamp existing buckets
      // and replace their constraint atomically, after excluding active draws.
      await db.query("UPDATE player_quotas SET tokens = $1 WHERE tokens > $1", [MAX_QUOTA])
      await db.query(
        "ALTER TABLE player_quotas DROP CONSTRAINT IF EXISTS player_quotas_tokens_check",
      )
      await db.query(
        `ALTER TABLE player_quotas ADD CONSTRAINT player_quotas_tokens_check CHECK (tokens BETWEEN 0 AND ${MAX_QUOTA})`,
      )
      await db.query(
        `INSERT INTO board_tiles(game_id, tile_id, edges, boxes)
        SELECT 1, n, decode(repeat('00', 48 + CASE WHEN n / 125 = 124 THEN 3 ELSE 0 END
          + CASE WHEN n % 125 = 124 THEN 3 ELSE 0 END), 'hex'), decode(repeat('00', 24), 'hex')
        FROM generate_series(0, $1::integer - 1) AS n ON CONFLICT DO NOTHING`,
        [TILE_COUNT],
      )
      await db.query("COMMIT")
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    } finally {
      db.release()
    }
  }

  async game() {
    const {
      rows: [row],
    } = await this.pool.query("SELECT * FROM games WHERE game_id = 1")
    return { ...row, started_at: Number(row.started_at) }
  }

  async quota(playerId: string) {
    const {
      rows: [row],
    } = await this.pool.query<QuotaRow>(
      "SELECT tokens, last_refill_at FROM player_quotas WHERE game_id = 1 AND player_id = $1",
      [playerId],
    )
    const now = Date.now(),
      quota = refillQuota(row, now)
    return this.quotaResponse(quota, now)
  }

  private quotaResponse(quota: { tokens: number; lastRefillAt: number }, now: number) {
    return {
      quotaRemaining: quota.tokens,
      refillIn:
        quota.tokens === MAX_QUOTA
          ? 0
          : Math.max(0, (QUOTA_REFILL_INTERVAL_MS - (now - quota.lastRefillAt)) / 1000),
    }
  }

  async draw(identity: Identity, edgeId: number): Promise<DrawResult> {
    if (!isValidEdgeId(edgeId)) return { ok: false, code: "INVALID_EDGE", status: 400 }
    // One autocommit statement: query resolution follows commit/ReadyForQuery,
    // so no application round trips occur between acquiring and releasing locks.
    const {
      rows: [{ result }],
    } = await this.pool.query<{ result: DrawResult }>(
      "SELECT boxes_draw($1::uuid, $2::integer, $3::integer, $4::jsonb) AS result",
      [identity.playerId, identity.teamId, edgeId, DRAW_RULES],
    )
    return result
  }

  async reset(): Promise<void> {
    // Administrative operation: the exclusive game lock waits for all moves'
    // compatible KEY SHARE locks before clearing tiles and quotas together.
    const db = await this.pool.connect()
    try {
      await db.query("BEGIN")
      await db.query("SELECT game_id FROM games WHERE game_id = 1 FOR UPDATE")
      await db.query(
        "UPDATE games SET started_at = GREATEST(started_at + 1, $1), edges_placed = 0, scores = ARRAY[0,0,0,0], complete = false WHERE game_id = 1",
        [Date.now()],
      )
      await db.query(
        "UPDATE board_tiles SET edges = decode(repeat('00', octet_length(edges)), 'hex'), boxes = decode(repeat('00', 24), 'hex'), revision = revision + 1 WHERE game_id = 1",
      )
      await db.query("DELETE FROM player_quotas WHERE game_id = 1")
      await db.query("COMMIT")
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    } finally {
      db.release()
    }
  }
}
