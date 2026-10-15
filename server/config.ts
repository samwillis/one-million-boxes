import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"

export function runtimeConfig() {
  // Node's env loader preserves values already supplied by the host/launcher.
  // Keep credentials in the environment; never expose them through Vite.
  for (const name of [".env.local", ".env"]) {
    try {
      loadEnvFile(fileURLToPath(new URL(`../${name}`, import.meta.url)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const required = (name: string, legacyName?: string) => {
    const value = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined)
    if (!value)
      throw new Error(`Missing ${name}. Copy .env.example to .env and configure your Neon project.`)
    return value
  }
  const databaseUrl = required("DATABASE_URL")
  // Capabilities must address the same database as the writer (usually neondb
  // on Neon); a fixed "postgres" name would seal the wrong query scope.
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) || "postgres"
  return {
    databaseUrl,
    databaseName,
    // Prefer the names emitted by neon env pull. Keep previous deployment
    // variables working while hosts migrate their environment configuration.
    realtimeUrl: required("NEON_REALTIME_URL", "REALTIME_PUBLIC_URL"),
    secret: required("NEON_REALTIME_SECRET", "REALTIME_SECRET"),
    identitySecret: required("TEAM_COOKIE_SECRET"),
    port: Number(process.env.API_PORT ?? "3001"),
  }
}
