import { serve } from "@hono/node-server"
import pg from "pg"
import { createApp } from "./app.js"
import { runtimeConfig } from "./config.js"
import { GameStore } from "./store.js"

const config = runtimeConfig()
const pool = new pg.Pool({ connectionString: config.databaseUrl })
const store = new GameStore(pool)
// Run pnpm db:init before starting the API; startup never changes the schema.
const app = createApp(config, store)

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port })
console.log(`Game API: http://127.0.0.1:${config.port}`)

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0))
    })
  })
