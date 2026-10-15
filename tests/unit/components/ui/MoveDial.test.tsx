import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { REFILL_INTERVAL_MS, useQuota } from "../../../../src/contexts/quota-context"
import { TeamProvider } from "../../../../src/contexts/team-context"
import { MoveDial } from "../../../../src/components/ui/MoveDial"

vi.mock("../../../../src/contexts/quota-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/contexts/quota-context")>()),
  useQuota: vi.fn(),
}))
const mockUseQuota = vi.mocked(useQuota)

function showDial(remaining = 8, nextRefillAt: number | null = null) {
  mockUseQuota.mockReturnValue({
    remaining,
    max: 8,
    refillIn: 0,
    nextRefillAt,
    emptyMoveAttempts: 0,
    notifyNoMoves: vi.fn(),
    consume: vi.fn(),
    syncFromServer: vi.fn(),
    refund: vi.fn(),
    bonusCount: 0,
    bonusPosition: null,
    setBonusPosition: vi.fn(),
    clearBonus: vi.fn(),
    localBoxesCompleted: 0,
  })
  return render(
    <TeamProvider team="BLUE" teamId={1}>
      <MoveDial />
    </TeamProvider>,
  )
}

describe("MoveDial", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the available count and an accessible description", () => {
    showDial(5)
    expect(screen.getByTestId("move-dial-count")).toHaveTextContent("5")
    expect(screen.getByRole("img")).toHaveAccessibleName("5 of 8 moves available")
  })

  it.each([0, 3, 8])("fills exactly %i of eight segments", (remaining) => {
    showDial(remaining)
    const segments = screen.getByTestId("move-dial-segments")
    expect(segments.children).toHaveLength(8)
    expect(segments.querySelectorAll('[data-filled="true"]')).toHaveLength(remaining)
  })

  it("uses the player's team colour", () => {
    showDial()
    expect(screen.getByTestId("move-dial").style.getPropertyValue("--ammo-color")).toBe("#1E88E5")
  })

  it("shows the refill state when no moves remain", () => {
    showDial(0)
    expect(screen.getByTestId("move-dial")).toHaveAttribute("data-empty", "true")
    expect(screen.getByRole("img")).toHaveAccessibleName("0 of 8 moves available, recharging")
    expect(screen.getByText("Refill")).toBeInTheDocument()
  })

  it("animates the next empty segment until the refill deadline", () => {
    showDial(2, Date.now() + REFILL_INTERVAL_MS)
    expect(screen.getByTestId("move-dial-charge")).toBeInTheDocument()
  })

  it("has no refill sweep when full", () => {
    showDial(8, Date.now() + REFILL_INTERVAL_MS)
    expect(screen.queryByTestId("move-dial-charge")).not.toBeInTheDocument()
  })

  it("keeps the refill sweep and number stable across a spend followed by a box bonus", () => {
    const deadline = Date.now() + REFILL_INTERVAL_MS
    const { rerender } = showDial(5, deadline)
    const charge = screen.getByTestId("move-dial-charge")
    const count = screen.getByTestId("move-dial-count")
    const timing = charge.getAttribute("style")
    const quota = mockUseQuota()

    // The optimistic spend and authoritative refund + bonus arrive separately.
    for (const remaining of [4, 6]) {
      mockUseQuota.mockReturnValue({ ...quota, remaining })
      rerender(
        <TeamProvider team="BLUE" teamId={1}>
          <MoveDial />
        </TeamProvider>,
      )
      expect(screen.getByTestId("move-dial-charge")).toBe(charge)
      expect(charge.getAttribute("style")).toBe(timing)
      expect(screen.getByTestId("move-dial-count")).toBe(count)
      expect(count).toHaveTextContent(String(remaining))
      expect(
        screen.getByTestId("move-dial-segments").querySelectorAll('[data-filled="true"]'),
      ).toHaveLength(remaining)
    }
  })
})
