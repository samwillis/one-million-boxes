import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { QUOTA_KEY, QuotaProvider, useQuota } from "../../../src/contexts/quota-context"

function QuotaProbe() {
  const { remaining, consume, emptyMoveAttempts } = useQuota()
  return (
    <>
      <button onClick={consume}>{remaining}</button>
      <output aria-label="Blocked moves">{emptyMoveAttempts}</output>
    </>
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.mocked(localStorage.getItem).mockReset()
  localStorage.clear()
})

it("signals every empty draw attempt without consuming moves", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"))
  const emptyQuota = JSON.stringify({ remaining: 0, lastRefillAt: Date.now(), version: 1 })
  vi.mocked(localStorage.getItem).mockImplementation((key) =>
    key === QUOTA_KEY ? emptyQuota : null,
  )
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  )
  render(
    <QuotaProvider>
      <QuotaProbe />
    </QuotaProvider>,
  )

  fireEvent.click(screen.getByRole("button"))
  fireEvent.click(screen.getByRole("button"))
  expect(screen.getByRole("button")).toHaveTextContent("0")
  expect(screen.getByLabelText("Blocked moves")).toHaveTextContent("2")

  act(() => {
    vi.advanceTimersByTime(3000)
  })
  fireEvent.click(screen.getByRole("button"))
  expect(screen.getByRole("button")).toHaveTextContent("0")
  expect(screen.getByLabelText("Blocked moves")).toHaveTextContent("2")
})

it("starts a new refill interval when a move is spent after idling at full quota", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"))
  localStorage.clear()
  // Keep bootstrap pending to isolate the local optimistic clock from server sync.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  )
  render(
    <QuotaProvider>
      <QuotaProbe />
    </QuotaProvider>,
  )
  act(() => {
    vi.advanceTimersByTime(60000)
  })

  fireEvent.click(screen.getByRole("button"))
  expect(screen.getByRole("button")).toHaveTextContent("7")
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(screen.getByRole("button")).toHaveTextContent("7")
  act(() => {
    vi.advanceTimersByTime(2000)
  })
  expect(screen.getByRole("button")).toHaveTextContent("8")
})
