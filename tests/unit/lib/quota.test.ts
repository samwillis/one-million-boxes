import { expect, it } from "vitest"
import { refillQuota } from "../../../server/store"
it("preserves the refill clock, caps a full bucket and allows the configured timing leeway", () => {
  expect(refillQuota(undefined, 10000)).toEqual({ tokens: 8, lastRefillAt: 10000 })
  expect(refillQuota({ tokens: 0, last_refill_at: "10000" }, 15900)).toEqual({
    tokens: 1,
    lastRefillAt: 13000,
  })
  expect(refillQuota({ tokens: 0, last_refill_at: "10000" }, 12500, 500)).toEqual({
    tokens: 1,
    lastRefillAt: 13000,
  })
  expect(refillQuota({ tokens: 7, last_refill_at: "10000" }, 20000)).toEqual({
    tokens: 8,
    lastRefillAt: 20000,
  })
})
