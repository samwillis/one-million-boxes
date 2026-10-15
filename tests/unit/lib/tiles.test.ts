import { describe, expect, it } from "vitest"
import { GameState } from "../../../shared/game-state"
import { boxCoordsToId, coordsToEdgeId, EDGE_COUNT, getBoxEdges } from "../../../shared/edge-math"
import {
  TILE_COUNT,
  emptyTile,
  edgeLocation,
  getOwner,
  setOwner,
  visitTileEdges,
  visitTileBoxes,
} from "../../../shared/tiles"
import type { BoardTile } from "../../../shared/tiles"

describe("packed board tiles", () => {
  it("packs owners across byte boundaries without changing neighboring owners", () => {
    const data = new Uint8Array(54)
    for (let i = 0; i < 144; i++) setOwner(data, i, i % 5)
    for (let i = 0; i < 144; i++) expect(getOwner(data, i)).toBe(i % 5)
    setOwner(data, 2, 4)
    expect(getOwner(data, 1)).toBe(1)
    expect(getOwner(data, 2)).toBe(4)
    expect(getOwner(data, 3)).toBe(3)
    expect(() => setOwner(data, 144, 1)).toThrow()
  })
  it("owns every edge exactly once, including the outer boundary", () => {
    const seen = new Uint8Array(EDGE_COUNT)
    let count = 0,
      bytes = 0
    for (let tileId = 0; tileId < TILE_COUNT; tileId++) {
      const tile = emptyTile(tileId)
      bytes += tile.edges.length + tile.boxes.length
      visitTileEdges(tileId, (id, index) => {
        const location = edgeLocation(id)
        if (
          seen[id] ||
          location.tileId !== tileId ||
          location.index !== index ||
          index * 3 + 3 > tile.edges.length * 8
        )
          throw new Error(`Incorrect ownership for edge ${id}`)
        seen[id] = 1
        count++
      })
    }
    expect(count).toBe(EDGE_COUNT)
    expect(bytes).toBe(1125750)
  })
  it("hydrates claims from unordered tiles and clears authoritative owners on reset", () => {
    const expected = new GameState()
    const shared = coordsToEdgeId(8, 7, false)
    const edges = new Set([...getBoxEdges(7, 7), ...getBoxEdges(8, 7)])
    for (const edgeId of edges) if (edgeId !== shared) expected.applyEvent({ edgeId, teamId: 0 })
    expected.applyEvent({ edgeId: shared, teamId: 3 })
    const tiles = new Map<number, BoardTile>()
    for (const edgeId of edges)
      tiles.set(edgeLocation(edgeId).tileId, emptyTile(edgeLocation(edgeId).tileId))
    for (const tile of tiles.values()) {
      visitTileEdges(tile.tile_id, (id, index) =>
        setOwner(tile.edges, index, (expected.getEdgeOwner(id) ?? -1) + 1),
      )
      visitTileBoxes(tile.tile_id, (id, index) =>
        setOwner(tile.boxes, index, expected.getBoxOwner(id)),
      )
    }
    const actual = new GameState()
    for (const tile of [...tiles.values()].reverse()) actual.applyTile(tile)
    expect(actual.getScores()).toEqual([0, 0, 0, 2])
    expect(actual.getBoxOwner(boxCoordsToId(7, 7))).toBe(4)
    expect(actual.getEdgesPlacedCount()).toBe(7)
    for (const tile of tiles.values()) actual.applyTile(tile)
    expect(actual.getScores()).toEqual(expected.getScores())
    for (const tile of tiles.values()) actual.applyTile(emptyTile(tile.tile_id))
    expect(actual.getScores()).toEqual([0, 0, 0, 0])
    expect(actual.getEdgesPlacedCount()).toBe(0)
  })
})
