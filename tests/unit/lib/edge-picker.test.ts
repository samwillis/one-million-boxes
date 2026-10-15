import { describe, expect, it } from "vitest"
import { findNearestEdge } from "../../../src/lib/edge-picker"
import { W, H, coordsToEdgeId } from "../../../shared/edge-math"

describe("edge picking", () => {
  for (const touch of [false, true]) {
    it(`covers both ends of horizontal and vertical edges (${touch ? "touch" : "mouse"})`, () => {
      for (const offset of [0.01, 0.1, 0.9, 0.99]) {
        expect(findNearestEdge(10 + offset, 20, 20, touch)).toBe(coordsToEdgeId(10, 20, true))
        expect(findNearestEdge(10, 20 + offset, 20, touch)).toBe(coordsToEdgeId(10, 20, false))
      }
    })

    it(`chooses the closest edge near a junction (${touch ? "touch" : "mouse"})`, () => {
      expect(findNearestEdge(10.02, 20.1, 20, touch)).toBe(coordsToEdgeId(10, 20, false))
      expect(findNearestEdge(10.1, 20.02, 20, touch)).toBe(coordsToEdgeId(10, 20, true))
    })
  }

  it("includes outer endpoints and only returns valid boundary edges", () => {
    expect(findNearestEdge(0, 0, 20, false)).toBe(coordsToEdgeId(0, 0, true))
    expect(findNearestEdge(W, H, 20, false)).toBe(coordsToEdgeId(W - 1, H, true))
    expect(findNearestEdge(W, H - 0.01, 20, false)).toBe(coordsToEdgeId(W, H - 1, false))
    expect(findNearestEdge(W - 0.01, H, 20, false)).toBe(coordsToEdgeId(W - 1, H, true))
    expect(findNearestEdge(-0.1, 20.5, 20, false)).toBe(coordsToEdgeId(0, 20, false))
    expect(findNearestEdge(-0.3, 20.5, 20, false)).toBeNull()
  })

  it("retains mouse/touch hit widths and minimum zoom levels", () => {
    expect(findNearestEdge(10.5, 20.3, 20, false)).toBeNull()
    expect(findNearestEdge(10.5, 20.3, 20, true)).toBe(coordsToEdgeId(10, 20, true))
    expect(findNearestEdge(10.5, 20.5, 20, true)).toBeNull()
    expect(findNearestEdge(10.5, 20, 14, false)).toBeNull()
    expect(findNearestEdge(10.5, 20, 12, true)).toBe(coordsToEdgeId(10, 20, true))
    expect(findNearestEdge(10.5, 20, 11, true)).toBeNull()
    expect(findNearestEdge(NaN, 20, 20, false)).toBeNull()
  })
})
