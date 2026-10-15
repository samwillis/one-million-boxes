import { useMemo } from "react"
import type { CSSProperties } from "react"
import { REFILL_INTERVAL_MS, useQuota } from "../../contexts/quota-context"
import { useTeam } from "../../contexts/team-context"
import { useMoveCounterShake } from "../../hooks/useMoveCounterShake"
import { TEAM_COLORS } from "../../../shared/teams"
import "./MoveDial.css"

/** One rounded arc per move, with a small gap between adjacent segments. */
function segmentPath(index: number, max: number): string {
  const point = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180
    return `${22 + 18 * Math.cos(radians)} ${22 + 18 * Math.sin(radians)}`
  }
  const start = -90 + (index * 360) / max + 5
  const end = -90 + ((index + 1) * 360) / max - 5
  return `M ${point(start)} A 18 18 0 0 1 ${point(end)}`
}

/** Shared move HUD for the pencil cursor and the fixed board overlay. */
export function MoveDial({
  className = "",
  testId = "move-dial",
}: {
  className?: string
  testId?: string
}) {
  const { team } = useTeam()
  const { remaining, max, nextRefillAt, emptyMoveAttempts } = useQuota()
  const ref = useMoveCounterShake(emptyMoveAttempts)
  const teamColor = TEAM_COLORS[team].primary
  const segments = useMemo(() => Array.from({ length: max }, (_, i) => segmentPath(i, max)), [max])

  // Spending and box bonuses move the sweep to a different segment without
  // restarting it. Only a new refill deadline starts a new animation.
  const chargeStyle = useMemo(() => {
    const duration = Math.max(0, (nextRefillAt ?? Date.now()) - Date.now())
    return {
      "--charge-start": Math.min(1, duration / REFILL_INTERVAL_MS),
      "--charge-duration": `${Math.max(1, duration)}ms`,
    } as CSSProperties
  }, [nextRefillAt])

  return (
    <div
      ref={ref}
      className={`move-dial ${className}`}
      data-testid={testId}
      data-empty={remaining === 0}
      role="img"
      aria-label={`${remaining} of ${max} moves available${remaining === 0 ? ", recharging" : ""}`}
      style={{ "--ammo-color": remaining === 0 ? "#E53935" : teamColor } as CSSProperties}
    >
      <svg className="move-dial-ring" viewBox="0 0 44 44" fill="none" aria-hidden="true">
        <g data-testid={`${testId}-segments`}>
          {segments.map((path, i) => (
            <g key={i}>
              <path d={path} className="move-dial-track" />
              <path
                d={path}
                pathLength="1"
                className={`move-dial-segment${i < remaining ? " move-dial-segment--filled" : ""}`}
                data-filled={i < remaining}
              />
            </g>
          ))}
        </g>
        {nextRefillAt !== null && remaining < max && (
          <path
            key={nextRefillAt}
            d={segments[remaining]}
            pathLength="1"
            className="move-dial-charge"
            data-testid={`${testId}-charge`}
            style={chargeStyle}
          />
        )}
      </svg>
      <div className="move-dial-readout" aria-hidden="true">
        <span className="move-dial-count" data-testid={`${testId}-count`}>
          {remaining}
        </span>
        <span className="move-dial-label">{remaining === 0 ? "Refill" : "Moves"}</span>
      </div>
    </div>
  )
}
