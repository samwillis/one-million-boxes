import { expect, test } from "vitest"
import { emptyTile } from "../../../shared/tiles"
import { boardPayloadSize } from "../../../src/lib/realtime-diagnostics"

test("counts base64 protocol rows including keys and boundary tile bytes", () => {
  const rows = [0, 15624].map((tileId) => ({
    rowId: "a".repeat(64),
    row: { ...emptyTile(tileId), revision: 123 },
  }))
  const wireBytes = rows.reduce(
    (total, { rowId, row }) =>
      total +
      Buffer.byteLength(
        JSON.stringify({
          row_key: rowId,
          values: [
            String(row.tile_id),
            String(row.revision),
            { base64: Buffer.from(row.edges).toString("base64") },
            { base64: Buffer.from(row.boxes).toString("base64") },
          ],
        }),
      ),
    0,
  )
  expect(boardPayloadSize(rows)).toEqual({
    rows: 2,
    packedKB: 0.15,
    protocolRowsKB: wireBytes / 1000,
  })
})
