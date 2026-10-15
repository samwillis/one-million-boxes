import { expect, test } from "@playwright/test"
import { openGame } from "./helpers"

// Retina screens previously applied a conflicting border width to only some HUD controls.
test.use({ deviceScaleFactor: 2 })

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 667 },
  { width: 844, height: 390 },
]) {
  test(`floating controls fit over the full board at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await openGame(page)
    const canvas = (await page.getByTestId("game-canvas").boundingBox())!
    expect(canvas.y + canvas.height).toBeCloseTo(viewport.height, 0)

    const dial = (await page.getByTestId("quota-meter").boundingBox())!
    const link = (await page.locator(".footer-link").boundingBox())!
    const zoom = (await page.locator(".minimap-zoom-controls").boundingBox())!
    const minimap = (await page.getByTestId("world-view").boundingBox())!
    for (const box of [dial, link, zoom, minimap]) {
      expect(box.x).toBeGreaterThanOrEqual(canvas.x)
      expect(box.y).toBeGreaterThanOrEqual(canvas.y)
      expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width)
      expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height)
    }
    expect(zoom.x + zoom.width).toBeLessThan(minimap.x)
    const bottomControl = viewport.width <= 600 ? link : dial
    expect(zoom.y + zoom.height).toBeCloseTo(bottomControl.y + bottomControl.height, 0)
    expect(minimap.y + minimap.height).toBeCloseTo(bottomControl.y + bottomControl.height, 0)
    if (viewport.width <= 600) {
      expect(dial.y + dial.height).toBeLessThan(link.y)
    }
    await expect(page.getByTestId("world-view")).toHaveCSS("border-top-width", "1px")
    await expect(page.getByTestId("zoom-in")).toHaveCSS("border-top-width", "1px")
    for (const side of ["top", "right", "bottom", "left"]) {
      await expect(page.getByTestId("zoom-out")).toHaveCSS(`border-${side}-width`, "1px")
    }
    await expect(page.getByRole("button", { name: "About", exact: true })).toHaveCSS(
      "border-top-width",
      "1px",
    )
    const controls = [dial, link, zoom, minimap]
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i]
        const b = controls[j]
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true)
      }
    }

    // Empty space in the HUD row must still receive board input.
    const hitsCanvas = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid") === "game-canvas",
      { x: dial.x + dial.width + 4, y: dial.y + dial.height - 2 },
    )
    expect(hitsCanvas).toBe(true)

    if (viewport.width <= 600) {
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
      await expect(page.getByTestId("drawing-cursor")).toBeVisible()
      await expect(page.getByTestId("quota-meter")).toHaveCSS("opacity", "0")
      // Hiding the fixed dial must leave the link anchored at the bottom.
      expect(await page.locator(".footer-link").boundingBox()).toEqual(link)
    }
  })
}
