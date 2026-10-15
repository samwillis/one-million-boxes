import { useEffect, useRef } from "react"

/** Shake only the move display, keeping the pencil's drawing hotspot stationary. */
export function useMoveCounterShake(emptyMoveAttempts: number) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (emptyMoveAttempts === 0 || !ref.current) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    // Cancelling the previous animation lets every blocked click get feedback,
    // even when React batches repeated attempts with the same message.
    const animation = ref.current.animate(
      [0, -4, 4, -3, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 280, easing: "ease-out" },
    )
    return () => animation.cancel()
  }, [emptyMoveAttempts])

  return ref
}
