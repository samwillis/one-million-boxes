import { spawnSync } from "node:child_process"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)
const executable = join(dirname(require.resolve("pg-formatter")), "pg-formatter/pg_format")
type CaseStyle = "unchanged" | "lowercase" | "uppercase" | "capitalize"
const caseOptions: Record<CaseStyle, number> = {
  unchanged: 0,
  lowercase: 1,
  uppercase: 2,
  capitalize: 3,
}
const config: {
  spaces: number
  wrapLimit: number
  keepNewline: boolean
  noSpaceFunction: boolean
  keywordCase: CaseStyle
  functionCase: CaseStyle
  noRcFile: boolean
  stripComments: boolean
  placeholder: string
} = JSON.parse(await readFile(join(root, ".pg-format.json"), "utf8"))
const mode = process.argv[2]
if (mode !== "--write" && mode !== "--check") throw new Error("Use --write or --check")

// Invoke pgFormatter directly to check its exit status; the npm wrapper's
// format() API also concatenates stderr into its result on a failed invocation.
const args = [
  executable,
  "--spaces",
  String(config.spaces),
  "--keyword-case",
  String(caseOptions[config.keywordCase]),
  "--function-case",
  String(caseOptions[config.functionCase]),
]
if (config.noRcFile) args.push("--no-rcfile")
if (config.stripComments) args.push("--nocomment")
if (config.wrapLimit) args.push("--wrap-limit", String(config.wrapLimit))
if (config.keepNewline) args.push("--keep-newline")
if (config.noSpaceFunction) args.push("--no-space-function")
// pgFormatter 5.5 misindents nested bare RAISE in exception handlers. Preserve
// that small, manually indented block using its supported placeholder option.
if (config.placeholder) args.push("--placeholder", config.placeholder)

let needsFormatting = false
for (const name of (await readdir(join(root, "server")))
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  const path = join(root, "server", name)
  const source = await readFile(path, "utf8")
  const result = spawnSync("perl", args, { input: source, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pgFormatter failed for ${name}: ${result.stderr}`)
  // Line wrapping in pgFormatter can emit leading tabs even in spaces mode.
  const formatted = result.stdout.replace(/^[ \t]+/gm, (indent) => {
    let width = 0
    for (const character of indent) width += character === "\t" ? 8 - (width % 8) : 1
    return " ".repeat(width)
  })
  if (source === formatted) continue
  if (mode === "--write") {
    await writeFile(path, formatted)
    console.log(`Formatted server/${name}`)
  } else {
    console.error(`Needs formatting: server/${name}`)
    needsFormatting = true
  }
}
if (needsFormatting) process.exitCode = 1
else console.log("SQL formatting passed")
