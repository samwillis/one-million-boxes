import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { resolve, join } from "node:path"
import { runtimeConfig } from "../server/config"

const root = resolve(import.meta.dirname, "..")
const config = runtimeConfig()
const children: ChildProcess[] = []
let stopping = false

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
  process.exit(code)
}

function launch(args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" })
  children.push(child)
  child.on("error", (error) => {
    console.error(error)
    void shutdown(1)
  })
  child.on("exit", (code) => {
    if (!stopping) void shutdown(code || 1)
  })
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void shutdown(0)
  })

// Database and Realtime services belong to the configured Neon project.
// This launcher runs only the application API and frontend.
launch([join(root, "node_modules/tsx/dist/cli.mjs"), "watch", "server/index.ts"])
launch([join(root, "node_modules/vite/bin/vite.js")])
console.log(`1 Million Boxes: http://127.0.0.1:5173 (API on port ${config.port})`)
