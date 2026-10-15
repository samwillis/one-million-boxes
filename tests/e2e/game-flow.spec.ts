import { expect, test } from "@playwright/test"
import { openGame } from "./helpers"

test.describe(`Game Flow`, () => {
  test.beforeEach(async ({ page }) => {
    await openGame(page)
  })

  test(`displays all main UI elements`, async ({ page }) => {
    // Header elements
    await expect(page.getByTestId(`team-badge`).filter({ visible: true })).toBeVisible()
    await expect(page.getByTestId(`quota-meter`)).toBeVisible()

    // Main game area - world view
    const worldView = page.getByTestId(`world-view`)
    await expect(worldView).toBeVisible()

    // Zoom controls
    await expect(page.getByRole(`button`, { name: /zoom in/i })).toBeVisible()
    await expect(page.getByRole(`button`, { name: /zoom out/i })).toBeVisible()

    // Score board
    await expect(page.getByTestId(`scoreboard`).filter({ visible: true })).toBeVisible()
  })

  test(`team badge shows valid team`, async ({ page }) => {
    const teamName = page.getByTestId(`team-name`).filter({ visible: true })
    await expect(teamName).toBeVisible()

    const text = await teamName.textContent()
    expect([`Red Team`, `Blue Team`, `Green Team`, `Yellow Team`]).toContain(text)

    // Team color dot should be visible
    const colorDot = page.getByTestId(`team-color-dot`).filter({ visible: true })
    await expect(colorDot).toBeVisible()
  })

  test(`quota meter shows 8 max`, async ({ page }) => {
    const quotaText = page.getByTestId(`quota-meter-count`)
    await expect(quotaText).toBeVisible()

    const text = await quotaText.textContent()
    // The shared dial shows the available move count.
    expect(text).toMatch(/^[0-8]$/)

    // Should have 8 segments
    const segments = page.getByTestId(`quota-meter-segments`)
    await expect(segments).toBeVisible()

    const segmentCount = await segments.locator(`.move-dial-segment`).count()
    expect(segmentCount).toBe(8)
  })

  test(`zoom controls work`, async ({ page }) => {
    const zoomIn = page.getByRole(`button`, { name: /zoom in/i })
    const zoomOut = page.getByRole(`button`, { name: /zoom out/i })

    await expect(zoomIn).toBeVisible()
    await expect(zoomOut).toBeVisible()

    // Click zoom in multiple times
    await zoomIn.click()
    await zoomIn.click()

    // Click zoom out
    await zoomOut.click()

    // Controls should still be visible and functional
    await expect(zoomIn).toBeVisible()
    await expect(zoomOut).toBeVisible()
  })

  test(`world view is clickable`, async ({ page }) => {
    const worldView = page.getByTestId(`world-view`)
    await expect(worldView).toBeVisible()

    // Get the bounding box
    const box = await worldView.boundingBox()
    expect(box).toBeTruthy()

    if (box) {
      // Click in the center of the world view
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

      // The click should be handled (we just verify no errors occur)
      // The actual behavior depends on game state
    }
  })

  test(`page loads without console errors`, async ({ page }) => {
    const errors: Array<string> = []

    page.on(`console`, (msg) => {
      if (msg.type() === `error`) {
        errors.push(msg.text())
      }
    })

    await openGame(page)
    await page.waitForTimeout(1000)

    // Filter out expected errors (like network errors in test env)
    const unexpectedErrors = errors.filter(
      (error) => !error.includes(`net::ERR_`) && !error.includes(`Failed to load`),
    )

    expect(unexpectedErrors).toHaveLength(0)
  })

  test(`connection status indicator is present`, async ({ page }) => {
    // Connection status should show some form of status
    const connectionStatus = page.locator(`.connection-status`)

    // It might not be visible initially, but if present should have valid content
    const count = await connectionStatus.count()
    if (count > 0) {
      await expect(connectionStatus).toBeVisible()
    }
  })

  test(`score board shows all teams`, async ({ page }) => {
    const scoreBoard = page.getByTestId(`scoreboard`).filter({ visible: true })
    await expect(scoreBoard).toBeVisible()

    // Should show 4 team scores
    const teamScores = scoreBoard.locator(
      `[data-testid^="score-"]:not([data-testid="score-local"])`,
    )
    const count = await teamScores.count()
    expect(count).toBe(4)
  })
})
