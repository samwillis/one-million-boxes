import { useGameSoundPreference } from "../../lib/game-sounds"

export function SoundButton() {
  const { soundEnabled, toggleSound } = useGameSoundPreference()
  return (
    <button
      className="zoom-button minimap-sound-button"
      onClick={toggleSound}
      aria-label={soundEnabled ? "Mute sounds" : "Enable sounds"}
      aria-pressed={soundEnabled}
      title={soundEnabled ? "Mute sounds" : "Enable sounds"}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M11 5 6 9H3v6h3l5 4Z" />
        {soundEnabled ? (
          <>
            <path d="M15 8a6 6 0 0 1 0 8" />
            <path d="M18 5a10 10 0 0 1 0 14" />
          </>
        ) : (
          <path d="m16 9 6 6m0-6-6 6" />
        )}
      </svg>
    </button>
  )
}
