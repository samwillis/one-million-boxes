import { expect } from "@playwright/test"
import type { Page } from "@playwright/test"

export async function openGame(page: Page) {
  await page.goto("/")
  await expect(page.getByTestId("game-canvas")).toBeVisible({ timeout: 30000 })
  const play = page.getByRole("button", { name: /team, Play!/ })
  const dismissed = await page.evaluate(
    () => sessionStorage.getItem("boxes:about-dismissed") === "true",
  )
  if (!dismissed) {
    await expect(play).toBeVisible()
    await play.click()
  }
  await expect(page.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
}
