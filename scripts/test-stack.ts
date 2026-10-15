import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { connect } from "node:net"

const root = resolve(import.meta.dirname, "..")

export async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 30000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

/** All test writes target an owned disposable cluster, never the development game. */
export async function startTestStack(withUi = false) {
  const backend = process.env.NEON_REALTIME_BACKEND_DIR
  if (!backend)
    throw new Error("Set NEON_REALTIME_BACKEND_DIR to your matching Realtime backend checkout.")
  const pgBin = process.env.PG_BIN ?? join(root, ".local/realtime/pg_install/v18/bin")
  const proxyBin =
    process.env.REALTIME_PROXY_BIN ??
    join(backend, "pgxn/neon_realtime/target/debug/realtime-proxy")
  // macOS's default temp path is too long for Postgres's 103-byte Unix socket limit.
  const dir = await mkdtemp("/tmp/boxes-test-")
  const apiUrl = "http://127.0.0.1:3002",
    realtimeUrl = "ws://127.0.0.1:8081"
  const env = {
    ...process.env,
    PG_CONFIG: join(pgBin, "pg_config"),
    NEON_REALTIME_DEV_ROOT: dir,
    NEON_REALTIME_DEV_POSTGRES_PORT: "55441",
    NEON_REALTIME_DEV_LISTENER_PORT: "55442",
    API_PORT: "3002",
    REALTIME_PUBLIC_URL: realtimeUrl,
    REALTIME_SECRET: `nrt_live_1${randomBytes(32).toString("base64url")}`,
    TEAM_COOKIE_SECRET: randomBytes(32).toString("hex"),
    REALTIME_LISTEN_ADDR: "127.0.0.1:8081",
    REALTIME_BRANCH_ID: "test-branch",
    REALTIME_DATABASES: "postgres=test-database",
    REALTIME_ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    OTEL_SDK_DISABLED: "true",
  }
  const children: ChildProcess[] = []
  let stopping = false
  const launch = (bin: string, args: string[]) => {
    const child = spawn(bin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout?.on("data", (chunk) => {
      output = (output + chunk).slice(-16000)
    })
    child.stderr?.on("data", (chunk) => {
      output = (output + chunk).slice(-16000)
    })
    let error: Error | undefined
    child.on("error", (value) => {
      error = value
    })
    children.push(child)
    return {
      child,
      output: () => {
        if (error) throw error
        if (!stopping && (child.exitCode !== null || child.signalCode !== null))
          throw new Error(`${bin} exited:\n${output}`)
        return output
      },
    }
  }
  const stopChild = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
    await exited
    clearTimeout(timer)
  }
  const stop = async () => {
    if (stopping) return
    stopping = true
    for (const child of [...children].reverse()) await stopChild(child)
    await rm(dir, { recursive: true, force: true })
  }
  try {
    const database = launch("bash", [join(backend, "pgxn/neon_realtime/scripts/dev-server.sh")])
    await eventually(
      () => database.output().includes("Disposable Neon Realtime instance is ready."),
      "test Postgres startup",
    )
    const output = database.output()
    const databaseUrl = output.match(/NEON_REALTIME_DATABASE_URL='([^']+)'/)?.[1]
    const socket = output.match(/unix:\/\/([^']+)'/)?.[1]
    if (!databaseUrl || !socket) throw new Error("Missing test database connection details")
    Object.assign(env, {
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      NEON_REALTIME_URL: realtimeUrl,
      NEON_REALTIME_SECRET: env.REALTIME_SECRET,
      REALTIME_NEON_REALTIME_SOCKET: socket,
    })
    // Install only into the owned disposable database, before starting the API.
    await promisify(execFile)(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/init-db.ts"],
      {
        cwd: root,
        env,
        timeout: 30000,
      },
    )
    let proxy = launch(proxyBin, [])
    const waitProxy = async () =>
      eventually(async () => {
        proxy.output()
        return new Promise<boolean>((resolve) => {
          const socket = connect(8081, "127.0.0.1")
          socket.on("connect", () => {
            socket.destroy()
            resolve(true)
          })
          socket.on("error", () => resolve(false))
        })
      }, "test proxy startup")
    await waitProxy()
    const api = launch(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"])
    await eventually(async () => {
      api.output()
      return fetch(`${apiUrl}/api/health`)
        .then((response) => response.ok)
        .catch(() => false)
    }, "test API startup")
    if (withUi) {
      const ui = launch(process.execPath, ["node_modules/vite/bin/vite.js", "--port", "5174"])
      await eventually(async () => {
        ui.output()
        return fetch("http://127.0.0.1:5174")
          .then((response) => response.ok)
          .catch(() => false)
      }, "test UI startup")
    }
    return {
      databaseUrl,
      apiUrl,
      realtimeUrl,
      identitySecret: env.TEAM_COOKIE_SECRET,
      stop,
      restartProxy: async () => {
        await stopChild(proxy.child)
        proxy = launch(proxyBin, [])
        await waitProxy()
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}
