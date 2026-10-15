import { expect, test } from "@playwright/test"
import type { WebSocketRoute } from "@playwright/test"
import { userInfo } from "node:os"
import pg from "pg"
import { coordsToEdgeId, getBoxEdges } from "../../shared/edge-math"
import { TEAMS } from "../../shared/teams"
import { GameStore } from "../../server/store"
import { openGame } from "./helpers"

test("staggered browser reloads recover and report snapshot timings and sizes", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000)
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ])
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    await Promise.all(pages.map(openGame))
    const observations = pages.map(() => ({
      loaded: [] as Array<{
        receivedMs: number
        appliedMs: number
        applyDurationMs: number
        rows: number
        packedKB: number
        protocolRowsKB: number
      }>,
      rowBytes: new Map<string, number>(),
      boardId: "",
      rejections: [] as string[],
    }))
    pages.forEach((page, index) => {
      const result = observations[index]
      page.on("console", async (message) => {
        if (message.text().startsWith("[Board Realtime] Game state loaded"))
          result.loaded.push(await message.args()[1].jsonValue())
      })
      page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(payload.toString())
          if (frame.type === "subscribe_rejected") result.rejections.push(frame.code)
          if (frame.type === "subscribed" && frame.columns[0]?.name === "tile_id") {
            result.boardId = frame.live_id
            result.rowBytes.set(frame.live_id, 0)
          }
          if (frame.type === "baseline_sync_batch" && frame.live_id === result.boardId)
            result.rowBytes.set(
              frame.live_id,
              (result.rowBytes.get(frame.live_id) ?? 0) +
                frame.rows.reduce(
                  (total: number, row: unknown) => total + Buffer.byteLength(JSON.stringify(row)),
                  0,
                ),
            )
        })
      })
    })
    await pages[0].reload()
    // Join while the other browser is still receiving the large board snapshot.
    await pages[1].waitForTimeout(400)
    await pages[1].reload()
    for (const [index, page] of pages.entries()) {
      const result = observations[index]
      await expect.poll(() => result.loaded.length, { timeout: 30000 }).toBeGreaterThan(0)
      await expect(page.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
      const loaded = result.loaded.at(-1)!
      expect(loaded.rows).toBe(15625)
      expect(loaded.packedKB).toBe(1125.75)
      expect(loaded.appliedMs).toBeGreaterThanOrEqual(loaded.receivedMs)
      expect(loaded.applyDurationMs).toBeGreaterThanOrEqual(0)
      expect(loaded.protocolRowsKB).toBe(result.rowBytes.get(result.boardId)! / 1000)
    }
    await testInfo.attach("reload-diagnostics", {
      body: JSON.stringify(observations, (_key, value) =>
        value instanceof Map ? Object.fromEntries(value) : value,
      ),
      contentType: "application/json",
    })
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test("two browsers claim boxes, reconnect, reload and observe an atomic game reset", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000)
  const firstContext = await browser.newContext({ baseURL }),
    secondContext = await browser.newContext({ baseURL })
  const first = await firstContext.newPage(),
    second = await secondContext.newPage()
  let disconnectRealtime = false
  const sockets: WebSocketRoute[] = []
  await second.routeWebSocket("ws://127.0.0.1:8081", (socket) => {
    if (disconnectRealtime) {
      socket.close({ code: 1013, reason: "Test outage" })
      return
    }
    socket.connectToServer()
    sockets.push(socket)
  })
  const errors: string[] = []
  for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message))
  try {
    await Promise.all([openGame(first), openGame(second)])
    const identity = await (await first.request.get("/api/team")).json()
    const scoreId = `score-${TEAMS[identity.teamId].toLowerCase()}`
    const shared = coordsToEdgeId(500, 499, false)
    const edges = [...new Set([...getBoxEdges(499, 499), ...getBoxEdges(500, 499)])].filter(
      (id) => id !== shared,
    )
    for (const edgeId of edges) {
      const response = await first.request.post("/api/draw", { data: { edgeId } })
      expect(response.status()).toBe(200)
    }
    const canvas = first.getByTestId("game-canvas")
    const bounds = (await canvas.boundingBox())!
    const accepted = first.waitForResponse(
      (response) => response.url().endsWith("/api/draw") && response.request().method() === "POST",
    )
    // Move first so React installs the hover target before the click handler runs.
    await first.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 10)
    await expect(canvas).toBeVisible()
    await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 - 10 } })
    const response = await accepted
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, boxesClaimed: 2, quotaRemaining: 5 })
    for (const page of [first, second]) {
      await expect(
        page.getByTestId(scoreId).filter({ visible: true }).locator(".scoreboard-value"),
      ).toHaveText(/^2/)
      await expect(page.getByTestId("connection-status")).toBeHidden()
    }
    await first.screenshot({ path: ".local/screenshots/realtime-game.png" })

    const pixel = () =>
      second.getByTestId("game-canvas").evaluate((element) => {
        const canvas = element as HTMLCanvasElement
        const dpr = devicePixelRatio
        // Midpoint of the horizontal edge (502,502) at the default 20px cell spacing.
        return Array.from(
          canvas
            .getContext("2d")!
            .getImageData(
              Math.floor(canvas.width / 2 + 50 * dpr),
              Math.floor(canvas.height / 2 + 40 * dpr),
              1,
              1,
            ).data,
        )
      })
    const before = await pixel()
    disconnectRealtime = true
    sockets.forEach((socket) => socket.close({ code: 1012, reason: "Test disconnect" }))
    await expect(second.getByTestId("connection-status")).toContainText("Reconnecting", {
      timeout: 15000,
    })
    const remote = await first.request.post("/api/draw", {
      data: { edgeId: coordsToEdgeId(502, 502, true) },
    })
    expect(remote.status()).toBe(200)
    disconnectRealtime = false
    await expect(second.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
    await expect.poll(pixel).not.toEqual(before)
    await second.reload()
    await expect(second.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
    await expect(
      second.getByTestId(scoreId).filter({ visible: true }).locator(".scoreboard-value"),
    ).toHaveText(/^2/)

    // Only this test stack's database is touched; dev data uses a different port.
    const pool = new pg.Pool({
      connectionString: `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:55441/postgres`,
    })
    try {
      await new GameStore(pool).reset()
    } finally {
      await pool.end()
    }
    for (const page of [first, second]) {
      await expect(
        page.getByTestId(scoreId).filter({ visible: true }).locator(".scoreboard-value"),
      ).toHaveText("0", { timeout: 30000 })
      await expect(page.getByTestId("connection-status")).toBeHidden({ timeout: 30000 })
      await expect(page.getByTestId("quota-meter-count")).toHaveText("8")
    }
    expect(errors).toEqual([])
  } finally {
    await firstContext.close()
    await secondContext.close()
  }
})
