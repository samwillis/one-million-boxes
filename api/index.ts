import { attachDatabasePool } from "@vercel/functions"
import pg from "pg"
import { createApp } from "../server/app.js"
import { runtimeConfig } from "../server/config.js"
import { GameStore } from "../server/store.js"

const config = runtimeConfig()
// Reuse connections across Fluid compute requests. Neon's pooled endpoint
// multiplexes them; Vercel releases idle sockets when an instance is suspended.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
})
attachDatabasePool(pool)
const app = createApp(config, new GameStore(pool))

// Native Web handler: all /api routes share this stateless Hono application.
export default { fetch: app.fetch }
