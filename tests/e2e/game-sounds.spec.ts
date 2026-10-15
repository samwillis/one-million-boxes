import { expect, test } from "@playwright/test"
import { openGame } from "./helpers"
import type { Page } from "@playwright/test"

async function observeAudio(page: Page) {
  // Observe actual Web Audio playback without replacing the audio implementation.
  await page.addInitScript(() => {
    const starts: string[] = []
    Object.assign(window, { audioStarts: starts })
    const scratchStart = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      starts.push("scratch")
      return scratchStart.apply(this, args)
    }
    const noteStart = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (...args) {
      starts.push("note")
      return noteStart.apply(this, args)
    }
  })
}

const audioStarts = (page: Page) =>
  page.evaluate(() => (window as unknown as { audioStarts: string[] }).audioStarts)

for (const boxes of [0, 1, 2]) {
  test(`drawing plays a scratch and rewards ${boxes} confirmed boxes`, async ({ page }) => {
    await observeAudio(page)
    await page.route("**/api/draw", (route) =>
      route.fulfill({
        json: { ok: true, quotaRemaining: 7, refillIn: 3, boxesClaimed: boxes, txid: "0" },
      }),
    )
    await openGame(page)
    expect(await audioStarts(page)).toEqual([])
    const canvas = page.getByTestId("game-canvas")
    const bounds = (await canvas.boundingBox())!
    await canvas.click({ position: { x: bounds.width / 2 + 10, y: bounds.height / 2 + 60 } })
    const notes = boxes === 0 ? [] : Array(boxes === 1 ? 3 : 4).fill("note")
    await expect.poll(() => audioStarts(page)).toEqual(["scratch", ...notes])
  })
}

test("muting persists, rejected moves do not chime, and empty moves stay silent", async ({
  page,
}) => {
  await observeAudio(page)
  await page.route("**/api/draw", (route) =>
    route.fulfill({
      status: 409,
      json: { ok: false, code: "EDGE_TAKEN", quotaRemaining: 8, refillIn: 0 },
    }),
  )
  await openGame(page)
  await page.getByRole("button", { name: "Mute sounds" }).click()
  await page.reload()
  await expect(page.getByRole("button", { name: "Enable sounds" })).toHaveAttribute(
    "aria-pressed",
    "false",
  )
  await expect(page.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
  const canvas = page.getByTestId("game-canvas")
  const bounds = (await canvas.boundingBox())!
  const position = { x: bounds.width / 2 + 10, y: bounds.height / 2 + 60 }
  const mutedResponse = page.waitForResponse("**/api/draw")
  await canvas.click({ position })
  await mutedResponse
  expect(await audioStarts(page)).toEqual([])

  await page.getByRole("button", { name: "Enable sounds" }).click()
  const rejectedResponse = page.waitForResponse("**/api/draw")
  await canvas.click({ position })
  await rejectedResponse
  expect(await audioStarts(page)).toEqual(["scratch"])

  // Release empty quota after snapshot loading so refill cannot race the click.
  let releaseQuota!: () => void
  const quotaReady = new Promise<void>((resolve) => {
    releaseQuota = resolve
  })
  await page.route("**/api/quota", async (route) => {
    await quotaReady
    await route.fulfill({ json: { ok: true, quotaRemaining: 0, refillIn: 3 } })
  })
  await page.reload()
  await expect(page.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
  releaseQuota()
  await expect(page.getByTestId("quota-meter")).toContainText("0")
  await canvas.click({ position })
  await expect(page.getByTestId("error-toast")).toContainText("Out of moves!")
  expect(await audioStarts(page)).toEqual([])
})
