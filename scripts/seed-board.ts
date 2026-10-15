import type { Pool } from "pg"
import { GameState } from "../shared/game-state"
import {
  EDGE_COUNT,
  BOX_COUNT,
  W,
  boxCoordsToId,
  getAdjacentBoxes,
  getBoxEdges,
} from "../shared/edge-math"
import { boxLocation, edgeLocation, setOwner, TILE_COUNT } from "../shared/tiles"
import type { BoardTile } from "../shared/tiles"

/** Bulk administrative seeding, preserving all existing edges and box owners. */
export async function seedBoard(pool: Pool, percent: number, random: () => number): Promise<void> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    // Like reset, briefly exclude normal draws while reading and replacing state.
    // Keep started_at unchanged: clients receive tile updates without a reload.
    await db.query("SELECT game_id FROM games WHERE game_id = 1 FOR UPDATE")
    const { rows } = await db.query<BoardTile>(
      "SELECT tile_id, revision, edges, boxes FROM board_tiles WHERE game_id = 1 ORDER BY tile_id",
    )
    if (rows.length !== TILE_COUNT)
      throw new Error("Run pnpm db:init first to initialize the board")
    const state = new GameState()
    for (const tile of rows) state.applyTile(tile)
    const target = Math.ceil((BOX_COUNT * percent) / 100)
    const before = state.getTotalBoxesClaimed()
    if (before >= target) {
      await db.query("COMMIT")
      console.log(
        `Board already has ${before.toLocaleString()} completed boxes; no changes needed.`,
      )
      return
    }

    // Shuffle all free edges so the remaining holes stay distributed over the
    // board. Replay ordered moves through the shared rule oracle for valid claims.
    const edges = new Uint32Array(EDGE_COUNT - state.getEdgesPlacedCount())
    let next = 0
    for (let edgeId = 0; edgeId < EDGE_COUNT; edgeId++)
      if (!state.isEdgeTaken(edgeId)) edges[next++] = edgeId
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const previous = edges[i]
      edges[i] = edges[j]
      edges[j] = previous
    }
    const changed = new Set<number>()
    for (const edgeId of edges) {
      if (state.getTotalBoxesClaimed() >= target) break
      // A shared edge can close two boxes. Avoid overshooting an exact target.
      if (target - state.getTotalBoxesClaimed() === 1) {
        const claims = getAdjacentBoxes(edgeId).filter(
          ({ x, y }) =>
            state.getBoxOwner(boxCoordsToId(x, y)) === 0 &&
            getBoxEdges(x, y).every((edge) => edge === edgeId || state.isEdgeTaken(edge)),
        ).length
        if (claims > 1) continue
      }
      const teamId = Math.floor(random() * 4)
      const { boxesClaimed } = state.applyEvent({ edgeId, teamId })
      const edge = edgeLocation(edgeId)
      setOwner(rows[edge.tileId].edges, edge.index, teamId + 1)
      changed.add(edge.tileId)
      for (const boxId of boxesClaimed) {
        const box = boxLocation(boxId % W, Math.floor(boxId / W))
        setOwner(rows[box.tileId].boxes, box.index, teamId + 1)
        changed.add(box.tileId)
      }
    }
    if (state.getTotalBoxesClaimed() !== target)
      throw new Error("Unable to reach exact completion target")
    // Bounded SQL batches keep parameter counts and memory manageable. Commit
    // tile owners and counters together so Realtime sees one consistent change.
    const tiles = [...changed].map((tileId) => rows[tileId])
    for (let offset = 0; offset < tiles.length; offset += 500) {
      const batch = tiles.slice(offset, offset + 500)
      await db.query(
        `UPDATE board_tiles AS tile
         SET edges = seeded.edges, boxes = seeded.boxes, revision = tile.revision + 1
         FROM unnest($1::integer[], $2::bytea[], $3::bytea[]) AS seeded(tile_id, edges, boxes)
         WHERE tile.game_id = 1 AND tile.tile_id = seeded.tile_id`,
        [
          batch.map((tile) => tile.tile_id),
          batch.map((tile) => tile.edges),
          batch.map((tile) => tile.boxes),
        ],
      )
    }
    await db.query(
      "UPDATE games SET edges_placed = $1, scores = $2, complete = $3 WHERE game_id = 1",
      [state.getEdgesPlacedCount(), state.getScores(), state.isComplete()],
    )
    await db.query("COMMIT")
    console.log(
      `Seeded to ${percent}%: ${target.toLocaleString()} completed boxes, ${state.getEdgesPlacedCount().toLocaleString()} edges. Added ${(target - before).toLocaleString()} boxes; existing play preserved.`,
    )
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    db.release()
  }
}
