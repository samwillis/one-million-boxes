import pg from "pg"
import { runtimeConfig } from "../server/config"
import { GameStore } from "../server/store"
const pool = new pg.Pool({ connectionString: runtimeConfig().databaseUrl })
try {
  await new GameStore(pool).reset()
  console.log("Game reset; connected clients will reload the new board.")
} finally {
  await pool.end()
}
