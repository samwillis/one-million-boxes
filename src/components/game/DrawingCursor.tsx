import { useCallback, useEffect, useRef } from "react"
import type { CSSProperties, RefObject } from "react"
import { useTeam } from "../../contexts/team-context"
import { TEAM_COLORS } from "../../../shared/teams"
import { edgeIdToCoords } from "../../../shared/edge-math"
import { useViewStateContext } from "../../hooks/useViewState"
import { worldToScreen } from "../../lib/view-transform"
import { MoveDial } from "../ui/MoveDial"
import "./DrawingCursor.css"

interface DrawingCursorProps {
  containerRef: RefObject<HTMLDivElement | null>
  disabled: boolean
  pendingEdge: number | null
  onStrokeFrame: (edgeId: number | null, progress: number) => void
}

/**
 * A mouse-only pencil and move HUD. The tip is the real pointer hotspot;
 * movement updates a compositor transform without rerendering the board.
 * Touch and UI controls retain their normal input and quota display.
 */
export function DrawingCursor({
  containerRef,
  disabled,
  pendingEdge,
  onStrokeFrame,
}: DrawingCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null)
  const pencilRef = useRef<SVGSVGElement>(null)
  const pointerPosition = useRef({ x: 0, y: 0 })
  const strokeAnimation = useRef<Animation | null>(null)
  const strokeFrame = useRef<number | null>(null)
  const strokeEdge = useRef<number | null>(null)
  const lastStrokeEdge = useRef<number | null>(null)
  const { view, canvasSize } = useViewStateContext()
  const { team } = useTeam()
  const teamColor = TEAM_COLORS[team].primary

  const cancelStroke = useCallback(() => {
    strokeAnimation.current?.cancel()
    strokeAnimation.current = null
    if (strokeFrame.current !== null) cancelAnimationFrame(strokeFrame.current)
    strokeFrame.current = null
    if (strokeEdge.current !== null) {
      strokeEdge.current = null
      onStrokeFrame(null, 1)
    }
    if (pencilRef.current) pencilRef.current.dataset.drawing = "false"
  }, [onStrokeFrame])

  useEffect(() => {
    if (pendingEdge === null) {
      lastStrokeEdge.current = null
      return
    }
    if (lastStrokeEdge.current === pendingEdge) return
    lastStrokeEdge.current = pendingEdge
    const pencil = pencilRef.current
    const cursor = cursorRef.current
    if (!pencil || !cursor || disabled || cursor.dataset.visible !== "true") return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    // A pending edge exists only after the local move check succeeds. Trace its
    // endpoints without delaying the write or animating the moves dial itself.
    const edge = edgeIdToCoords(pendingEdge)
    const start = worldToScreen(edge.x, edge.y, view, canvasSize.width, canvasSize.height)
    const end = worldToScreen(
      edge.x + (edge.horizontal ? 1 : 0),
      edge.y + (edge.horizontal ? 0 : 1),
      view,
      canvasSize.width,
      canvasSize.height,
    )
    const pointer = pointerPosition.current
    const angle = cursor.style.getPropertyValue("--pencil-angle") || "0deg"
    const transform = (point: { x: number; y: number }) =>
      `translate(${point.x - pointer.x}px, ${point.y - pointer.y}px) rotate(${angle})`
    cancelStroke()
    pencil.dataset.drawing = "true"
    const animation = pencil.animate(
      [
        { transform: transform(pointer), offset: 0, easing: "ease-out" },
        { transform: transform(start), offset: 0.16 },
        { transform: transform(end), offset: 0.76, easing: "ease-out" },
        { transform: transform(pointer), offset: 1 },
      ],
      { duration: 260, easing: "linear" },
    )
    strokeAnimation.current = animation
    strokeEdge.current = pendingEdge
    onStrokeFrame(pendingEdge, 0)
    const paintStroke = () => {
      if (strokeAnimation.current !== animation) return
      // The same animation clock drives the pencil and canvas reveal. Only the
      // middle keyframe interval draws ink; approach and return leave it still.
      const progress = animation.effect?.getComputedTiming().progress ?? 0
      onStrokeFrame(pendingEdge, Math.max(0, Math.min(1, (progress - 0.16) / 0.6)))
      strokeFrame.current = requestAnimationFrame(paintStroke)
    }
    strokeFrame.current = requestAnimationFrame(paintStroke)
    animation.onfinish = () => {
      if (strokeAnimation.current === animation) cancelStroke()
    }
    // Let a completed stroke finish even if Realtime confirms the edge early.
    // Pointer movement, leaving the board and unmounting cancel it immediately.
  }, [pendingEdge, view, canvasSize, disabled, cancelStroke, onStrokeFrame])

  useEffect(() => {
    const container = containerRef.current
    const cursor = cursorRef.current
    if (!container || !cursor || disabled) return

    const mouseAvailable = window.matchMedia("(any-hover: hover) and (any-pointer: fine)")
    let frame: number | null = null
    let position = { x: 0, y: 0, width: 0, height: 0 }

    const hide = () => {
      cancelStroke()
      cursor.dataset.visible = "false"
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    }

    const paintPosition = () => {
      frame = null
      const { x, y, width, height } = position
      pointerPosition.current = { x, y }
      const left = x > width - 82
      const above = y > height - 62
      const pencilAngle = y < 48 ? (left ? 180 : 90) : left ? -90 : 0

      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`
      cursor.style.setProperty("--dial-x", left ? "-68px" : "22px")
      cursor.style.setProperty("--dial-y", above ? "-54px" : "8px")
      cursor.style.setProperty("--pencil-angle", `${pencilAngle}deg`)
      if (cursor.dataset.visible !== "true") cursor.dataset.visible = "true"
    }

    const move = (event: PointerEvent) => {
      cancelStroke()
      if (event.pointerType !== "mouse" || !mouseAvailable.matches) {
        hide()
        return
      }
      const rect = container.getBoundingClientRect()
      position = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
      }
      if (frame === null) frame = requestAnimationFrame(paintPosition)
    }

    // Native cursor suppression is a stable board capability, not a per-frame
    // mutation. Toggling cursor CSS while moving can flash the OS cursor.
    const syncMouseAvailability = () => {
      if (mouseAvailable.matches) container.dataset.pencilEnabled = "true"
      else delete container.dataset.pencilEnabled
      hide()
    }
    syncMouseAvailability()

    container.addEventListener("pointermove", move)
    container.addEventListener("pointerleave", hide)
    container.addEventListener("pointercancel", hide)
    container.addEventListener("wheel", cancelStroke, { passive: true })
    window.addEventListener("blur", hide)
    document.addEventListener("visibilitychange", hide)
    mouseAvailable.addEventListener("change", syncMouseAvailability)
    return () => {
      hide()
      delete container.dataset.pencilEnabled
      container.removeEventListener("pointermove", move)
      container.removeEventListener("pointerleave", hide)
      container.removeEventListener("pointercancel", hide)
      container.removeEventListener("wheel", cancelStroke)
      window.removeEventListener("blur", hide)
      document.removeEventListener("visibilitychange", hide)
      mouseAvailable.removeEventListener("change", syncMouseAvailability)
    }
  }, [containerRef, disabled, cancelStroke])

  return (
    <div
      ref={cursorRef}
      className="drawing-cursor"
      data-testid="drawing-cursor"
      data-visible="false"
      aria-hidden="true"
      style={{ "--pencil-color": teamColor } as CSSProperties}
    >
      {/* The pencil tip is (4,44), which CSS anchors exactly to the pointer. */}
      <svg
        ref={pencilRef}
        className="drawing-cursor-pencil"
        data-testid="drawing-pencil"
        data-drawing="false"
        viewBox="0 0 48 48"
        fill="none"
      >
        <g stroke="#262626" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 44 10 27 32 5 43 16 21 38Z" fill="#F0B375" />
          <path d="M10 27 32 5 43 16 21 38Z" fill="var(--pencil-color)" />
          <path d="m15 32 22-22" stroke="white" strokeOpacity="0.65" />
          <path d="m32 5 2-2q2-2 4 0l7 7q2 2 0 4l-2 2Z" fill="#FFCCE5" />
          <path d="m29 8 11 11 3-3L32 5Z" fill="#D7D8DB" />
          <path d="m4 44 3-8 5 5Z" fill="#262626" />
        </g>
      </svg>

      <MoveDial className="cursor-ammo" testId="cursor-ammo" />
    </div>
  )
}
