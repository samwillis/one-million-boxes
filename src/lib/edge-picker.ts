import { H, W, coordsToEdgeId } from "../../shared/edge-math"

/**
 * Detect if the current device supports touch
 */
export function isTouchDevice(): boolean {
  return (
    `ontouchstart` in window ||
    navigator.maxTouchPoints > 0 ||
    // @ts-expect-error msMaxTouchPoints is IE-specific
    navigator.msMaxTouchPoints > 0
  )
}

/**
 * Find the nearest edge to a world coordinate.
 * Returns the edge ID if one is close enough, or null otherwise.
 *
 * Only picks edges if zoomed in enough.
 * Touch devices have a larger hit radius and lower minimum zoom requirement.
 *
 * @param worldX - X coordinate in world space
 * @param worldY - Y coordinate in world space
 * @param scale - Pixels per grid cell (zoom * DOT_SPACING)
 * @param isTouch - Whether this is a touch interaction (defaults to isTouchDevice())
 */
export function findNearestEdge(
  worldX: number,
  worldY: number,
  scale: number,
  isTouch?: boolean,
): number | null {
  // Default to device detection if not specified
  const touchMode = isTouch ?? isTouchDevice()

  // Minimum scale (pixels per cell) for edge picking
  // Touch devices need lower threshold for easier selection
  const minScale = touchMode ? 12 : 15
  if (![worldX, worldY, scale].every(Number.isFinite) || scale < minScale) return null

  // Larger hit radius for touch to accommodate finger imprecision
  const hitRadius = touchMode ? 0.4 : 0.25

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const horizontalX = clamp(Math.floor(worldX), 0, W - 1)
  const horizontalY = clamp(Math.round(worldY), 0, H)
  const verticalX = clamp(Math.round(worldX), 0, W)
  const verticalY = clamp(Math.floor(worldY), 0, H - 1)

  // Measure distance to each full segment, including its endpoints. Clamping
  // the projection gives round hit caps without selecting beyond the board.
  const horizontalDistance = Math.hypot(
    worldX - clamp(worldX, horizontalX, horizontalX + 1),
    worldY - horizontalY,
  )
  const verticalDistance = Math.hypot(
    worldX - verticalX,
    worldY - clamp(worldY, verticalY, verticalY + 1),
  )
  if (Math.min(horizontalDistance, verticalDistance) > hitRadius) return null

  // At intersections, pick the closer line instead of favoring a horizontal
  // edge's overlapping hit area. Exact ties consistently select horizontal.
  return horizontalDistance <= verticalDistance
    ? coordsToEdgeId(horizontalX, horizontalY, true)
    : coordsToEdgeId(verticalX, verticalY, false)
}
