import { expect, test } from "@playwright/test"
import { openGame } from "./helpers"

for (const pixelRatio of [1, 1.3, 2]) {
  test.describe(`Board density ${pixelRatio}`, () => {
    test.use({ deviceScaleFactor: pixelRatio })

    test("keeps the minimap sharp across responsive sizes", async ({ page }) => {
      await openGame(page)
      const minimap = page.getByTestId("world-view").locator("canvas")
      for (const width of [1600, 500]) {
        await page.setViewportSize({ width, height: 900 })
        await expect
          .poll(() =>
            minimap.evaluate((el) => {
              const canvas = el as HTMLCanvasElement
              const size = canvas.getBoundingClientRect().width
              const ctx = canvas.getContext("2d")!
              const expected = Math.round(size * devicePixelRatio)
              return {
                widthMatches: canvas.width === expected,
                heightMatches: canvas.height === expected,
                scaleMatches: Math.abs(ctx.getTransform().a - expected / size) < 0.0001,
                smoothing: ctx.imageSmoothingEnabled,
                quality: ctx.imageSmoothingQuality,
              }
            }),
          )
          .toEqual({
            widthMatches: true,
            heightMatches: true,
            scaleMatches: true,
            smoothing: true,
            quality: "high",
          })
      }
    })

    test("keeps tile resolution and antialiasing through a drawing frame", async ({ page }) => {
      // Observe real texture dimensions and transforms without changing rendering.
      await page.addInitScript(() => {
        const samples: Array<{ pixels: number; period: number }> = []
        Object.assign(window, { patternSamples: samples })
        const original = CanvasRenderingContext2D.prototype.createPattern
        CanvasRenderingContext2D.prototype.createPattern = function (source, repetition) {
          const pattern = original.call(this, source, repetition)
          if (pattern && source instanceof OffscreenCanvas) {
            const setTransform = pattern.setTransform.bind(pattern)
            pattern.setTransform = (matrix) => {
              samples.push({ pixels: source.width, period: source.width * (matrix?.a ?? 1) })
              setTransform(matrix)
            }
          }
          return pattern
        }
      })
      await page.route("**/api/draw", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 350))
        await route.fulfill({
          status: 409,
          json: { ok: false, code: "EDGE_TAKEN", quotaRemaining: 8, refillIn: 0 },
        })
      })
      await openGame(page)
      const canvas = page.getByTestId("game-canvas")
      const inspect = () =>
        canvas.evaluate((el) => {
          const canvas = el as HTMLCanvasElement
          const rect = canvas.getBoundingClientRect()
          const ctx = canvas.getContext("2d")!
          return {
            width: canvas.width,
            height: canvas.height,
            expectedWidth: Math.floor(rect.width * devicePixelRatio),
            expectedHeight: Math.floor(rect.height * devicePixelRatio),
            scale: ctx.getTransform().a,
            smoothing: ctx.imageSmoothingEnabled,
            quality: ctx.imageSmoothingQuality,
          }
        })
      const before = await inspect()
      expect(before.width).toBe(before.expectedWidth)
      expect(before.height).toBe(before.expectedHeight)
      expect(before.scale).toBeCloseTo(pixelRatio)
      expect(before.smoothing).toBe(true)
      expect(before.quality).toBe("high")
      const samples = await page.evaluate(
        () =>
          (window as unknown as { patternSamples: Array<{ pixels: number; period: number }> })
            .patternSamples,
      )
      expect(samples.length).toBeGreaterThanOrEqual(2)
      for (const sample of samples) {
        expect(sample.pixels).toBe(Math.ceil(128 * pixelRatio))
        // Preserve four-cell spacing, allowing native DOMMatrix float rounding.
        expect(sample.period).toBeCloseTo(80, 4)
      }
      const bounds = (await canvas.boundingBox())!
      const position = { x: bounds.width / 2 + 10, y: bounds.height / 2 + 40 }
      await page.mouse.move(bounds.x + position.x, bounds.y + position.y)
      await canvas.click({ position })
      await expect(page.getByTestId("drawing-pencil")).toHaveAttribute("data-drawing", "true")
      expect(await inspect()).toEqual(before)
      await expect(page.getByTestId("drawing-pencil")).toHaveAttribute("data-drawing", "false")
      expect(await inspect()).toEqual(before)
    })
  })
}
