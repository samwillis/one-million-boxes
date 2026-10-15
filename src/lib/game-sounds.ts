import { useSyncExternalStore } from "react"

const SOUND_KEY = "boxes:sound-enabled"
let enabled = true
try {
  enabled = localStorage.getItem(SOUND_KEY) !== "false"
} catch {
  // Sound preferences still work when browser storage is unavailable.
}

const listeners = new Set<() => void>()
let context: AudioContext | null = null
let output: GainNode | null = null

/** Lazily unlock audio from a drawing gesture, respecting browser autoplay rules. */
function getAudio(): AudioContext | null {
  if (!enabled || document.hidden || typeof AudioContext === "undefined") return null
  if (!context) {
    context = new AudioContext()
    output = context.createGain()
    output.gain.value = 0.35
    output.connect(context.destination)
  }
  if (context.state === "suspended") void context.resume().catch(() => {})
  return context
}

/** A brief, filtered noise stroke, timed to the pencil's movement along an edge. */
export function playPencilSound(): void {
  try {
    const audio = getAudio()
    if (!audio) return
    const duration = 0.16
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate)
    const samples = buffer.getChannelData(0)
    let friction = 0
    let pressure = 0
    const frictionBlend = 1 - Math.exp((-2 * Math.PI * 1100) / audio.sampleRate)
    const pressureBlend = 1 - Math.exp((-2 * Math.PI * 45) / audio.sampleRate)
    for (let i = 0; i < samples.length; i++) {
      // Correlated noise gives graphite a dry friction texture rather than a
      // white-noise hiss. Slower random variations imitate changing pressure.
      const noise = Math.random() * 2 - 1
      friction += frictionBlend * (noise - friction)
      pressure += pressureBlend * (noise - pressure)
      samples[i] = (friction * 0.9 + noise * 0.08) * (0.7 + Math.min(0.3, Math.abs(pressure) * 3))
    }
    const source = audio.createBufferSource()
    source.buffer = buffer
    const filter = audio.createBiquadFilter()
    filter.type = "bandpass"
    filter.frequency.value = 1200
    filter.Q.value = 0.5
    const gain = audio.createGain()
    const start = audio.currentTime + 0.04
    // Swell through the stroke, then ease off as the pencil lifts. The longer
    // attack and release make changing pressure audible rather than a flat hiss.
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(0.9, start + 0.065)
    gain.gain.linearRampToValueAtTime(0, start + duration)
    source.connect(filter).connect(gain).connect(output!)
    source.onended = () => {
      source.disconnect()
      filter.disconnect()
      gain.disconnect()
    }
    source.start(start)
  } catch {
    // Audio is optional; a device or browser audio failure must never block a move.
  }
}

/** Reward only the player's server-confirmed claims, with an extra note for two boxes. */
export function playBoxSound(boxes: number): void {
  if (boxes <= 0) return
  try {
    const audio = getAudio()
    if (!audio) return
    const notes = boxes > 1 ? [784, 1046.5, 1318.5, 1568] : [784, 1046.5, 1318.5]
    notes.forEach((frequency, index) => {
      const start = audio.currentTime + index * 0.07
      const oscillator = audio.createOscillator()
      oscillator.type = "sine"
      oscillator.frequency.value = frequency
      const gain = audio.createGain()
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.22, start + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2)
      oscillator.connect(gain).connect(output!)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
      }
      oscillator.start(start)
      oscillator.stop(start + 0.21)
    })
  } catch {
    // Keep successful moves independent of audio availability.
  }
}

function toggleSound(): void {
  enabled = !enabled
  // Silence already scheduled notes immediately when muting.
  if (context && output) output.gain.setValueAtTime(enabled ? 0.35 : 0, context.currentTime)
  try {
    localStorage.setItem(SOUND_KEY, String(enabled))
  } catch {
    // The current session can still be muted without persistence.
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useGameSoundPreference() {
  const soundEnabled = useSyncExternalStore(subscribe, () => enabled)
  return { soundEnabled, toggleSound }
}
