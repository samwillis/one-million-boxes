import { spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { existsSync } from "node:fs"
const root = resolve(import.meta.dirname, "..")
const backend = process.env.NEON_REALTIME_BACKEND_DIR
if (!backend)
  throw new Error("Set NEON_REALTIME_BACKEND_DIR to your matching Realtime backend checkout.")
// The backend oracle smoke test needs matching SDK sources. The application
// itself always uses the published @neon/realtime dependency.
const neon = process.env.NEON_PKGS_DIR
if (!neon) throw new Error("Set NEON_PKGS_DIR to your matching SDK source checkout.")
const local = join(root, ".local/realtime")
function run(cwd: string, bin: string, args: string[], env = process.env) {
  const result = spawnSync(bin, args, { cwd, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`)
}
await mkdir(local, { recursive: true })
if (existsSync(join(root, ".local/dev/pgdata/postmaster.pid"))) {
  throw new Error("Stop pnpm dev:local before rebuilding its Postgres extensions.")
}
const cached = existsSync(join(local, "pg_install/v18/bin/pg_config"))
if (!cached) {
  const expected = spawnSync("git", ["rev-parse", "HEAD:vendor/postgres-v18"], {
    cwd: backend,
    encoding: "utf8",
  }).stdout?.trim()
  const actual = spawnSync("git", ["-C", "vendor/postgres-v18", "rev-parse", "HEAD"], {
    cwd: backend,
    encoding: "utf8",
  }).stdout?.trim()
  if (actual && expected !== actual)
    throw new Error(
      "The backend's Postgres submodule is at a different revision. Use a source-matched checkout for setup; this script preserves existing checkouts.",
    )
}
run(
  backend,
  "make",
  [
    "-j8",
    "realtime-client-oracle-smoke",
    `POSTGRES_INSTALL_DIR=${join(local, "pg_install")}`,
    `PGRX_HOME=${join(local, "pgrx")}`,
    `BUILD_DIR=${join(local, "build")}`,
    ...(cached ? ["PG_INSTALL_CACHED=1"] : []),
  ],
  {
    ...process.env,
    NEON_PKGS_CHECKOUT: neon,
    ...(existsSync(join(neon, "node_modules")) ? { NEON_PKGS_SKIP_INSTALL: "1" } : {}),
  },
)
run(backend, "cargo", [
  "build",
  "--locked",
  "--manifest-path",
  "pgxn/neon_realtime/Cargo.toml",
  "-p",
  "realtime-proxy",
  "--bin",
  "realtime-proxy",
])
console.log("Local backend built and smoke-tested. Run pnpm dev:local.")
