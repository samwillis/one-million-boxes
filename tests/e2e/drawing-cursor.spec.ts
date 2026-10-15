import { expect, test } from "@playwright/test"
import { openGame } from "./helpers"
import { TEAM_COLORS, TEAMS } from "../../shared/teams"

test("pencil tracks the pointer, keeps its dial on the board, and restores the footer outside", async ({
  page,
}) => {
  await openGame(page)
  const canvas = page.getByTestId("game-canvas")
  const bounds = (await canvas.boundingBox())!
  // Hide the native cursor before entry and keep it hidden through movement,
  // rather than toggling its CSS alongside every pencil animation frame.
  await expect(canvas).toHaveCSS("cursor", "none")
  const cursor = page.getByTestId("drawing-cursor")
  const dial = page.getByTestId("cursor-ammo")
  const footerQuota = page.getByTestId("quota-meter")

  await page.mouse.move(bounds.x + 160, bounds.y + 140)
  await expect(cursor).toBeVisible()
  await expect(footerQuota).toHaveCSS("opacity", "0")
  const hotspot = (await cursor.boundingBox())!
  expect(hotspot.x).toBeCloseTo(bounds.x + 160, 0)
  expect(hotspot.y).toBeCloseTo(bounds.y + 140, 0)
  await expect(page.getByTestId("cursor-ammo-count")).toHaveText("8")
  for (let step = 0; step < 12; step++) {
    await page.mouse.move(bounds.x + 160 + step * 12, bounds.y + 140 + (step % 2) * 10)
    await expect(canvas).toHaveCSS("cursor", "none")
    await expect(cursor).toBeVisible()
  }

  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height - 2)
  await expect
    .poll(async () => {
      const box = (await dial.boundingBox())!
      return (
        box.x >= bounds.x &&
        box.y >= bounds.y &&
        box.x + box.width <= bounds.x + bounds.width &&
        box.y + box.height <= bounds.y + bounds.height
      )
    })
    .toBe(true)

  await page.getByRole("button", { name: "About", exact: true }).hover()
  await expect(cursor).toBeHidden()
  await expect(page.getByRole("button", { name: "About", exact: true })).toHaveCSS(
    "cursor",
    "pointer",
  )
  await expect(canvas).toHaveCSS("cursor", "none")
  await expect(footerQuota).toHaveCSS("opacity", "1")
})

test("dial animates the server-aligned refill, shows empty ammo, and respects reduced motion", async ({
  page,
}) => {
  // Hold the quota response until the board is loaded so the refill deadline
  // is deterministic regardless of snapshot latency. No game rows are changed.
  let releaseQuota!: () => void
  const quotaReady = new Promise<void>((resolve) => {
    releaseQuota = resolve
  })
  await page.route("**/api/quota", async (route) => {
    await quotaReady
    await route.fulfill({ json: { ok: true, quotaRemaining: 2, refillIn: 3 } })
  })
  await openGame(page)
  const bounds = (await page.getByTestId("game-canvas").boundingBox())!
  await page.mouse.move(bounds.x + 170, bounds.y + 140)
  releaseQuota()
  const count = page.getByTestId("cursor-ammo-count")
  const charge = page.getByTestId("cursor-ammo-charge")
  await expect(count).toHaveText("2")
  await expect(charge).toBeVisible()
  const offset = () => charge.evaluate((el) => parseFloat(getComputedStyle(el).strokeDashoffset))
  const initialOffset = await offset()
  await expect.poll(offset).toBeLessThan(initialOffset - 0.1)
  await expect(count).toHaveText("3", { timeout: 5000 })

  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(charge).toHaveCSS("animation-name", "none")
  await page.emulateMedia({ reducedMotion: "no-preference" })

  await page.route("**/api/draw", (route) =>
    route.fulfill({
      status: 429,
      json: { ok: false, code: "QUOTA_EXHAUSTED", quotaRemaining: 0, refillIn: 3 },
    }),
  )
  await page
    .getByTestId("game-canvas")
    .click({ position: { x: bounds.width / 2 + 10, y: bounds.height / 2 } })
  await expect(count).toHaveText("0")
  await expect(page.getByTestId("cursor-ammo")).toHaveAttribute("data-empty", "true")
  await expect(page.getByTestId("cursor-ammo").getByText("Refill", { exact: true })).toBeVisible()
  const toast = page.getByTestId("error-toast")
  await expect(toast).toContainText("Out of moves! Recharging...")
  const dialTransform = () =>
    page.getByTestId("cursor-ammo").evaluate((el) => getComputedStyle(el).transform)
  await expect.poll(dialTransform).not.toBe("none")
  await expect.poll(dialTransform).toBe("none")

  // A second attempt is rejected locally. The same message still shakes again.
  await page
    .getByTestId("game-canvas")
    .click({ position: { x: bounds.width / 2 + 10, y: bounds.height / 2 } })
  await expect.poll(dialTransform).not.toBe("none")
  await expect(count).toHaveText("1", { timeout: 5000 })
  await expect(toast).toBeHidden()
})

test.describe("Touch ammo fallback", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test("touch keeps the footer ammo without a floating cursor", async ({ page }) => {
    await openGame(page)
    const bounds = (await page.getByTestId("game-canvas").boundingBox())!
    // Touch input keeps the meter even when a mouse is also moved on the page.
    await page.touchscreen.tap(bounds.x + 80, bounds.y + 100)
    await page.mouse.move(bounds.x + 80, bounds.y + 100)
    await expect(page.getByTestId("drawing-cursor")).toBeHidden()
    await expect(page.getByTestId("quota-meter")).toBeVisible()
    await expect(page.getByTestId("quota-meter")).toHaveCSS("opacity", "1")
  })
})

test("accepted moves trace either edge direction, then return the pencil to the pointer", async ({
  page,
}) => {
  await page.route("**/api/quota", (route) =>
    route.fulfill({ json: { ok: true, quotaRemaining: 3, refillIn: 3 } }),
  )
  // Keep this a visual test: the authoritative board is never changed.
  await page.route("**/api/draw", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fulfill({
      status: 409,
      json: { ok: false, code: "EDGE_TAKEN", quotaRemaining: 3, refillIn: 3 },
    })
  })
  await openGame(page)
  const canvas = page.getByTestId("game-canvas")
  const bounds = (await canvas.boundingBox())!
  const pencil = page.getByTestId("drawing-pencil")
  for (const horizontal of [true, false]) {
    const position = {
      x: bounds.width / 2 + (horizontal ? 10 : 0),
      y: bounds.height / 2 + (horizontal ? 0 : 10),
    }
    await page.mouse.move(bounds.x + position.x, bounds.y + position.y)
    await canvas.click({ position })
    await expect(pencil).toHaveAttribute("data-drawing", "true")
    const frames = await pencil.evaluate((el) =>
      (el.getAnimations()[0].effect as KeyframeEffect)
        .getKeyframes()
        .map((frame) => frame.transform),
    )
    expect(frames[1]).toContain(horizontal ? "translate(-10px, 0px)" : "translate(0px, -10px)")
    expect(frames[2]).toContain(horizontal ? "translate(10px, 0px)" : "translate(0px, 10px)")
    await expect(pencil).toHaveAttribute("data-drawing", "false")
    await expect(page.getByTestId("cursor-ammo-count")).toHaveText("3")
  }
})

test("empty moves and reduced motion skip pencil strokes", async ({ page }) => {
  // Start the refill clock after snapshot hydration, keeping the empty state deterministic.
  let releaseQuota!: () => void
  let quotaReady = new Promise<void>((resolve) => {
    releaseQuota = resolve
  })
  let quotaRemaining = 0
  await page.route("**/api/quota", async (route) => {
    await quotaReady
    await route.fulfill({ json: { ok: true, quotaRemaining, refillIn: 3 } })
  })
  await openGame(page)
  releaseQuota()
  const canvas = page.getByTestId("game-canvas")
  const bounds = (await canvas.boundingBox())!
  const position = { x: bounds.width / 2 + 10, y: bounds.height / 2 }
  await page.mouse.move(bounds.x + position.x, bounds.y + position.y)
  await expect(page.getByTestId("cursor-ammo-count")).toHaveText("0")
  await canvas.click({ position })
  await expect(page.getByTestId("error-toast")).toContainText("Out of moves!")
  await expect(page.getByTestId("drawing-pencil")).toHaveAttribute("data-drawing", "false")

  await page.emulateMedia({ reducedMotion: "reduce" })
  quotaRemaining = 3
  quotaReady = new Promise<void>((resolve) => {
    releaseQuota = resolve
  })
  await page.route("**/api/draw", (route) =>
    route.fulfill({
      status: 409,
      json: { ok: false, code: "EDGE_TAKEN", quotaRemaining: 3, refillIn: 3 },
    }),
  )
  await openGame(page)
  releaseQuota()
  await page.mouse.move(bounds.x + position.x, bounds.y + position.y)
  await expect(page.getByTestId("cursor-ammo-count")).toHaveText("3")
  await canvas.click({ position })
  await expect(page.getByTestId("drawing-pencil")).toHaveAttribute("data-drawing", "false")
})

test("ink follows the pencil even when Realtime confirms before the stroke ends", async ({
  page,
}) => {
  await openGame(page)
  const identity = await (await page.request.get("/api/team")).json()
  const color = TEAM_COLORS[TEAMS[identity.teamId as number]].primary
  const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  const canvas = page.getByTestId("game-canvas")
  const bounds = (await canvas.boundingBox())!
  const position = { x: bounds.width / 2 + 10, y: bounds.height / 2 }
  await page.mouse.move(bounds.x + position.x, bounds.y + position.y)
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/draw"))
  await canvas.click({ position })
  const pencil = page.getByTestId("drawing-pencil")
  await expect(pencil).toHaveAttribute("data-drawing", "true")

  // Pause the real pencil clock at deterministic positions. Its canvas frame
  // loop keeps running, so this checks actual rendered ink rather than CSS flags.
  const sample = async (time: number) =>
    pencil.evaluate(async (el, time) => {
      const animation = el.getAnimations()[0]
      animation.pause()
      animation.currentTime = time
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="game-canvas"]')!
      const ctx = canvas.getContext("2d")!
      const dpr = devicePixelRatio
      const x = canvas.getBoundingClientRect().width / 2
      const y = canvas.getBoundingClientRect().height / 2
      const pixels = (offset: number) =>
        Array.from(
          ctx.getImageData(
            Math.round((x + offset) * dpr),
            Math.round((y - 3) * dpr),
            Math.round(4 * dpr),
            Math.round(6 * dpr),
          ).data,
        )
      return { behind: pixels(2), ahead: pixels(13) }
    }, time)

  const blank = await sample(0)
  const response = await saved
  expect(response.status()).toBe(200)
  await expect(page.getByTestId("cursor-ammo-count")).toHaveText("7")
  // Team-coloured ink proves the committed owner arrived through Realtime.
  // Keep the pencil halfway along the edge while that confirmation happens.
  await expect
    .poll(async () => {
      const pixels = (await sample(105)).behind
      for (let i = 0; i < pixels.length; i += 4) {
        if (rgb.every((channel, j) => Math.abs(pixels[i + j] - channel) < 3)) return true
      }
      return false
    })
    .toBe(true)
  const halfway = await sample(105)
  expect(halfway.behind).not.toEqual(blank.behind)
  expect(halfway.ahead).toEqual(blank.ahead)
  const complete = await sample(200)
  expect(complete.ahead).not.toEqual(blank.ahead)
  await pencil.evaluate((el) => el.getAnimations()[0].finish())
  await expect(pencil).toHaveAttribute("data-drawing", "false")
})
