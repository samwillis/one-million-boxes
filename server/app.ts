import { Hono } from "hono"
import { createRealtime, rawSql } from "@neon/realtime/server"
import { z } from "zod"

import { teamIdToName } from "../shared/teams.js"
import type { runtimeConfig } from "./config.js"
import {
  buildIdentityCookieHeader,
  createIdentityCookie,
  generatePlayerId,
  generateTeamId,
  parseIdentityCookie,
} from "./lib/identity-cookie.js"
import { BOARD_QUERY, GAME_QUERY, GameStore } from "./store.js"

/** Builds the stateless HTTP API around a host-managed Postgres pool. */
export function createApp(config: ReturnType<typeof runtimeConfig>, store: GameStore) {
  const issuer = createRealtime({ secret: config.secret, db: config.databaseName })
  const app = new Hono()

  // Identity, quota and short-lived query capabilities must not be cached.
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  })

  /**
   * GET /api/health
   * Reports that the API is running. Database setup is a separate deployment step.
   */
  app.get("/api/health", (c) => c.json({ ok: true }))

  /**
   * GET /api/team
   * Returns the player's identity and team from their signed cookie. A missing or
   * invalid cookie creates a new player, random team and HTTP-only identity cookie.
   */
  app.get("/api/team", async (c) => {
    let identity = await parseIdentityCookie(c.req.header("cookie"), config.identitySecret)
    if (!identity) {
      identity = { playerId: generatePlayerId(), teamId: generateTeamId() }
      c.header(
        "Set-Cookie",
        buildIdentityCookieHeader(
          await createIdentityCookie(identity.playerId, identity.teamId, config.identitySecret),
          process.env.NODE_ENV === "production",
        ),
      )
    }
    return c.json({ ...identity, team: teamIdToName(identity.teamId) })
  })

  /**
   * GET /api/quota
   * Returns the signed player's available lines and seconds until the next refill.
   * This is a read-only projection; missing or invalid identity returns 401.
   */
  app.get("/api/quota", async (c) => {
    const identity = await parseIdentityCookie(c.req.header("cookie"), config.identitySecret)
    if (!identity) return c.json({ ok: false, code: "NO_IDENTITY" }, 401)
    return c.json({ ok: true, ...(await store.quota(identity.playerId)) })
  })

  /**
   * GET /api/realtime
   * Issues short-lived capabilities for the fixed board and reset-generation
   * queries, together with the WebSocket URL and current game start timestamp.
   * Browsers connect directly to Realtime; the signing secret stays on the server.
   */
  app.get("/api/realtime", async (c) => {
    const game = await store.game()
    const query = await issuer.seal({ query: rawSql(BOARD_QUERY, [1]) })
    const gameQuery = await issuer.seal({ query: rawSql(GAME_QUERY, [1]) })
    return c.json({ query, gameQuery, startedAt: game.started_at, url: config.realtimeUrl })
  })

  /**
   * POST /api/draw
   * Accepts { edgeId } for the player/team verified from their signed cookie.
   * Postgres validates and applies the move atomically in one function call.
   * Success follows commit and includes the transaction ID for Realtime confirmation;
   * rejected moves return the store's HTTP status and error code.
   */
  app.post("/api/draw", async (c) => {
    const identity = await parseIdentityCookie(c.req.header("cookie"), config.identitySecret)
    if (!identity) return c.json({ ok: false, code: "NO_IDENTITY" }, 401)
    const parsed = z
      .object({ edgeId: z.number().int().min(0) })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ ok: false, code: "INVALID_REQUEST" }, 400)
    const { status, ...result } = await store.draw(identity, parsed.data.edgeId)
    return c.json(result, status)
  })

  app.onError((error, c) => {
    console.error(error)
    return c.json({ ok: false, code: "DATABASE_ERROR" }, 503)
  })

  return app
}
