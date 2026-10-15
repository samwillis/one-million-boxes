import type { RawLiveQueryRow } from "@neon/realtime/client"
import type { BoardTile } from "../../shared/tiles"

/**
 * Size of board rows in protocol v1 JSON, including row keys and base64 wrappers.
 * The SDK exposes decoded rows, so reconstruct their size without allocating
 * base64 strings. This excludes message envelopes, separators and transport
 * overhead; it is not a measurement of compressed network traffic.
 */
export function boardPayloadSize(rows: readonly RawLiveQueryRow<BoardTile>[]) {
  let packedBytes = 0
  let protocolRowBytes = 0
  for (const { rowId, row } of rows) {
    packedBytes += row.edges.byteLength + row.boxes.byteLength
    protocolRowBytes +=
      JSON.stringify({
        row_key: rowId,
        values: [String(row.tile_id), String(row.revision), { base64: "" }, { base64: "" }],
      }).length +
      4 * Math.ceil(row.edges.byteLength / 3) +
      4 * Math.ceil(row.boxes.byteLength / 3)
  }
  return {
    rows: rows.length,
    packedKB: Number((packedBytes / 1000).toFixed(3)),
    protocolRowsKB: Number((protocolRowBytes / 1000).toFixed(3)),
  }
}
