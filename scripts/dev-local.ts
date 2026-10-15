import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { resolve, join } from "node:path"
import { userInfo } from "node:os"
import pg from "pg"

const root = resolve(import.meta.dirname, "..")
const local = join(root, ".local/dev")
const backend = process.env.NEON_REALTIME_BACKEND_DIR
if (!backend)
  throw new Error("Set NEON_REALTIME_BACKEND_DIR to your matching Realtime backend checkout.")
const pgBin = process.env.PG_BIN ?? join(root, ".local/realtime/pg_install/v18/bin")
const proxy =
  process.env.REALTIME_PROXY_BIN ?? join(backend, "pgxn/neon_realtime/target/debug/realtime-proxy")
const data = join(local, "pgdata"),
  pgSocket = join(local, "postgres-socket"),
  realtimeSocket = join(local, "realtime-socket")
const children: ChildProcess[] = []
let stopping = false,
  ownsPostgres = false
const env = { ...process.env }

function command(bin: string, args: string[]) {
  const result = spawnSync(bin, args, { cwd: root, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`)
}
function launch(bin: string, args: string[]) {
  const child = spawn(bin, args, { cwd: root, env, stdio: "inherit" })
  children.push(child)
  child.on("error", (error) => {
    console.error(error)
    void shutdown(1)
  })
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${bin} exited (${code})`)
      void shutdown(code || 1)
    }
  })
  return child
}
async function shutdown(code: number) {
  if (stopping) return
  stopping = true
  const exited = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
      }),
  )
  await Promise.race([Promise.all(exited), new Promise((resolve) => setTimeout(resolve, 5000))])
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  if (ownsPostgres) command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"])
  process.exit(code)
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void shutdown(0)
  })

try {
  await mkdir(local, { recursive: true })
  let persisted: Record<string, string> = {}
  try {
    persisted = JSON.parse(await readFile(join(local, "runtime.json"), "utf8"))
  } catch {
    /* First run. */
  }
  env.REALTIME_SECRET ??=
    persisted.REALTIME_SECRET ?? `nrt_live_1${randomBytes(32).toString("base64url")}`
  env.TEAM_COOKIE_SECRET ??= persisted.TEAM_COOKIE_SECRET ?? randomBytes(32).toString("hex")
  env.REALTIME_PUBLIC_URL ??= "ws://127.0.0.1:8080"
  env.API_PORT ??= "3001"
  env.OTEL_SDK_DISABLED ??= "true"
  if (!existsSync(proxy))
    throw new Error("Realtime proxy is missing. Run pnpm setup:local-realtime first.")
  if (!env.DATABASE_URL) {
    if (!existsSync(join(pgBin, "initdb")))
      throw new Error("Postgres is missing. Run pnpm setup:local-realtime first.")
    await mkdir(pgSocket, { recursive: true })
    await mkdir(realtimeSocket, { recursive: true })
    if (!existsSync(join(data, "PG_VERSION"))) {
      command(join(pgBin, "initdb"), ["-D", data, "-A", "trust", "--no-locale", "--encoding=UTF8"])
      await writeFile(
        join(data, "postgresql.auto.conf"),
        `listen_addresses = '127.0.0.1'
port = 55431
unix_socket_directories = '${pgSocket.replaceAll("'", "''")}'
shared_preload_libraries = 'neon_rmgr,neon_realtime'
wal_level = logical
output_plugin_libraries = 'neon_realtime'
max_replication_slots = 8
max_wal_senders = 8
max_worker_processes = 16
max_prepared_transactions = 10
neon_realtime.listen_address = '127.0.0.1'
neon_realtime.port = 55432
neon_realtime.unix_socket_directory = '${realtimeSocket.replaceAll("'", "''")}'
`,
      )
    }
    const status = spawnSync(join(pgBin, "pg_ctl"), ["-D", data, "status"], { stdio: "ignore" })
    if (status.status === 0)
      throw new Error("This app's Postgres is already running; stop the other dev session first.")
    command(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(local, "postgres.log"), "-w", "start"])
    ownsPostgres = true
    env.DATABASE_URL = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:55431/postgres`
    env.REALTIME_NEON_REALTIME_SOCKET = join(realtimeSocket, "neon_realtime.sock")
  }
  if (!env.REALTIME_NEON_REALTIME_SOCKET)
    throw new Error("Set REALTIME_NEON_REALTIME_SOCKET when using an external DATABASE_URL")
  await writeFile(
    join(local, "runtime.json"),
    JSON.stringify(
      {
        DATABASE_URL: env.DATABASE_URL,
        REALTIME_SECRET: env.REALTIME_SECRET,
        TEAM_COOKIE_SECRET: env.TEAM_COOKIE_SECRET,
        REALTIME_PUBLIC_URL: env.REALTIME_PUBLIC_URL,
        API_PORT: env.API_PORT,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS neon_realtime")
  } finally {
    await pool.end()
  }
  // Fixture setup is a one-off script, separate from the watched API process.
  // Pin both URLs so .env.local can never direct this setup at a cloud database.
  env.NEON_REALTIME_URL = env.REALTIME_PUBLIC_URL
  env.NEON_REALTIME_SECRET = env.REALTIME_SECRET
  env.DATABASE_URL_UNPOOLED = env.DATABASE_URL
  command(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/init-db.ts"])
  env.REALTIME_LISTEN_ADDR ??= new URL(env.REALTIME_PUBLIC_URL).host
  env.REALTIME_BRANCH_ID ??= "local-branch"
  env.REALTIME_DATABASES ??= "postgres=local-database"
  env.REALTIME_ALLOWED_ORIGINS ??= "http://127.0.0.1:5173,http://localhost:5173"
  launch(proxy, [])
  launch(process.execPath, [
    join(root, "node_modules/tsx/dist/cli.mjs"),
    "watch",
    "server/index.ts",
  ])
  launch(process.execPath, [join(root, "node_modules/vite/bin/vite.js")])
  console.log(
    "\n1 Million Boxes: http://127.0.0.1:5173\nPostgres data persists in .local/dev/pgdata. Ctrl-C stops the stack.\n",
  )
} catch (error) {
  console.error(error)
  await shutdown(1)
}
