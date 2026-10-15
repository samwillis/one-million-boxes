import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { runtimeConfig } from "../../../server/config"

// Keep these checks independent of developer credentials and local env files.
vi.mock("node:process", () => {
  const loadEnvFile = vi.fn()
  return { loadEnvFile, default: { loadEnvFile } }
})

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:password@localhost/demo")
  vi.stubEnv("TEAM_COOKIE_SECRET", "test-identity-secret")
  for (const name of [
    "NEON_REALTIME_URL",
    "NEON_REALTIME_SECRET",
    "REALTIME_PUBLIC_URL",
    "REALTIME_SECRET",
  ])
    vi.stubEnv(name, undefined)
})
afterEach(() => vi.unstubAllEnvs())

it("uses the Realtime variables emitted by neon env pull", () => {
  vi.stubEnv("NEON_REALTIME_URL", "wss://realtime.example.com")
  vi.stubEnv("NEON_REALTIME_SECRET", "published-secret")
  const config = runtimeConfig()
  expect(config.realtimeUrl).toBe("wss://realtime.example.com")
  expect(config.secret).toBe("published-secret")
  expect(config.databaseName).toBe("demo")
})

it("keeps deployments using the previous variable names working", () => {
  vi.stubEnv("REALTIME_PUBLIC_URL", "wss://previous.example.com")
  vi.stubEnv("REALTIME_SECRET", "previous-secret")
  expect(runtimeConfig()).toMatchObject({
    realtimeUrl: "wss://previous.example.com",
    secret: "previous-secret",
  })
})

it("prefers CLI variables when both names are supplied", () => {
  vi.stubEnv("NEON_REALTIME_URL", "wss://realtime.example.com")
  vi.stubEnv("NEON_REALTIME_SECRET", "published-secret")
  vi.stubEnv("REALTIME_PUBLIC_URL", "wss://previous.example.com")
  vi.stubEnv("REALTIME_SECRET", "previous-secret")
  expect(runtimeConfig()).toMatchObject({
    realtimeUrl: "wss://realtime.example.com",
    secret: "published-secret",
  })
})

it("reports the canonical variable name when Realtime is unconfigured", () => {
  expect(() => runtimeConfig()).toThrow("Missing NEON_REALTIME_URL")
})
