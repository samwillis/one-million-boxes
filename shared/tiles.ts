import { boxCoordsToId, coordsToEdgeId, edgeIdToCoords, isValidEdgeId } from "./edge-math.js"
import { GRID_WIDTH, GRID_HEIGHT } from "./game-config.js"

export const TILE_SIZE = 8
export const TILE_COLUMNS = GRID_WIDTH / TILE_SIZE
export const TILE_ROWS = GRID_HEIGHT / TILE_SIZE
export const TILE_COUNT = TILE_COLUMNS * TILE_ROWS

export interface BoardTile {
  tile_id: number
  revision: number
  edges: Uint8Array
  boxes: Uint8Array
}

export function getOwner(bytes: Uint8Array, index: number): number {
  const bit = index * 3
  return ((bytes[bit >> 3] | ((bytes[(bit >> 3) + 1] ?? 0) << 8)) >> (bit & 7)) & 7
}

export function setOwner(bytes: Uint8Array, index: number, owner: number): void {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index * 3 + 3 > bytes.length * 8 ||
    !Number.isInteger(owner) ||
    owner < 0 ||
    owner > 4
  )
    throw new Error("Invalid packed owner")
  const bit = index * 3,
    byte = bit >> 3,
    shift = bit & 7
  const value = ((bytes[byte] | ((bytes[byte + 1] ?? 0) << 8)) & ~(7 << shift)) | (owner << shift)
  bytes[byte] = value & 255
  if (shift > 5) bytes[byte + 1] = value >> 8
}

export function tileOrigin(tileId: number): { x: number; y: number } {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= TILE_COUNT)
    throw new Error("Invalid tile ID")
  return {
    x: (tileId % TILE_COLUMNS) * TILE_SIZE,
    y: Math.floor(tileId / TILE_COLUMNS) * TILE_SIZE,
  }
}

export function boxLocation(x: number, y: number): { tileId: number; index: number } {
  return {
    tileId: Math.floor(y / TILE_SIZE) * TILE_COLUMNS + Math.floor(x / TILE_SIZE),
    index: (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE),
  }
}

export function edgeLocation(edgeId: number): { tileId: number; index: number } {
  if (!isValidEdgeId(edgeId)) throw new Error("Invalid edge ID")
  const { x, y, horizontal } = edgeIdToCoords(edgeId)
  const tileX = Math.floor(Math.min(x, GRID_WIDTH - 1) / TILE_SIZE)
  const tileY = Math.floor(Math.min(y, GRID_HEIGHT - 1) / TILE_SIZE)
  const tileId = tileY * TILE_COLUMNS + tileX
  if (horizontal && y === GRID_HEIGHT) return { tileId, index: 128 + (x % TILE_SIZE) }
  if (!horizontal && x === GRID_WIDTH)
    return { tileId, index: 128 + (tileY === TILE_ROWS - 1 ? TILE_SIZE : 0) + (y % TILE_SIZE) }
  return { tileId, index: (horizontal ? 0 : 64) + (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE) }
}

export function emptyTile(tileId: number): BoardTile {
  const { x, y } = tileOrigin(tileId)
  const edgeCount =
    128 + (x + TILE_SIZE === GRID_WIDTH ? 8 : 0) + (y + TILE_SIZE === GRID_HEIGHT ? 8 : 0)
  return {
    tile_id: tileId,
    revision: 0,
    edges: new Uint8Array((edgeCount * 3) / 8),
    boxes: new Uint8Array(24),
  }
}

export function visitTileEdges(
  tileId: number,
  visit: (edgeId: number, index: number) => void,
): void {
  const { x, y } = tileOrigin(tileId)
  for (let row = 0; row < TILE_SIZE; row++)
    for (let col = 0; col < TILE_SIZE; col++) {
      const index = row * TILE_SIZE + col
      visit(coordsToEdgeId(x + col, y + row, true), index)
      visit(coordsToEdgeId(x + col, y + row, false), 64 + index)
    }
  let index = 128
  if (y + TILE_SIZE === GRID_HEIGHT)
    for (let col = 0; col < TILE_SIZE; col++)
      visit(coordsToEdgeId(x + col, GRID_HEIGHT, true), index++)
  if (x + TILE_SIZE === GRID_WIDTH)
    for (let row = 0; row < TILE_SIZE; row++)
      visit(coordsToEdgeId(GRID_WIDTH, y + row, false), index++)
}

export function visitTileBoxes(
  tileId: number,
  visit: (boxId: number, index: number) => void,
): void {
  const { x, y } = tileOrigin(tileId)
  for (let row = 0; row < TILE_SIZE; row++)
    for (let col = 0; col < TILE_SIZE; col++)
      visit(boxCoordsToId(x + col, y + row), row * TILE_SIZE + col)
}

export function validateTile(tile: BoardTile): void {
  const expected = emptyTile(tile.tile_id)
  if (
    !Number.isSafeInteger(tile.revision) ||
    tile.revision < 0 ||
    !(tile.edges instanceof Uint8Array) ||
    !(tile.boxes instanceof Uint8Array) ||
    tile.edges.length !== expected.edges.length ||
    tile.boxes.length !== 24
  )
    throw new Error("Invalid board tile")
}
