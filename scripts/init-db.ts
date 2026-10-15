import pg from "pg"
import { runtimeConfig } from "../server/config"
import { GameStore } from "../server/store"

const config = runtimeConfig()
// Schema setup uses a direct connection and runs once before deployment.
// initialize() preserves existing tiles and game state.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? config.databaseUrl,
})
try {
  await new GameStore(pool).initialize()
  console.log("Game schema and tiles are ready.")
} finally {
  await pool.end()
}
