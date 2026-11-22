/**
 * The chat Webview's shared completion chime. Chromium only starts audio for a
 * document that has had a user gesture, and a completion cue arrives minutes
 * after the last one, so the context is warmed on the first interaction and
 * reused instead of being created at cue time.
 */
let context: AudioContext | undefined

/** A blocked context can leave `resume()` pending forever; the cue must not. */
const RESUME_TIMEOUT_MS = 1_500

function audioContext(): AudioContext | undefined {
  if (context !== undefined) return context
  if (typeof AudioContext === 'undefined') return undefined
  try {
    context = new AudioContext()
  } catch {
    context = undefined
  }
  return context
}

const isRunning = (audio: AudioContext): boolean => audio.state === 'running'

async function runningContext(audio: AudioContext, signal?: AbortSignal): Promise<boolean> {
  if (isRunning(audio)) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  try {
    const stopped = new Promise<boolean>((resolve) => {
      stop = () => resolve(false)
      timer = setTimeout(stop, RESUME_TIMEOUT_MS)
      signal?.addEventListener('abort', stop, { once: true })
    })
    const resumed = audio.resume().then(
      () => true,
      () => false,
    )
    return (await Promise.race([resumed, stopped])) && isRunning(audio)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (stop !== undefined) signal?.removeEventListener('abort', stop)
  }
}

/** Warm the shared context from inside a real user gesture. */
export function unlockCompletionCueAudio(): void {
  const audio = audioContext()
  if (audio === undefined || isRunning(audio)) return
  void audio.resume().catch(() => undefined)
}

/**
 * Play the two-tone completion chime. Returns false when this Webview cannot
 * produce sound, for example when playback policy still blocks the context.
 */
export async function playCompletionCueBell(signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted()
    const audio = audioContext()
    if (audio === undefined || !(await runningContext(audio, signal))) return false
    signal?.throwIfAborted()
    const start = audio.currentTime
    for (const [offset, frequency] of [
      [0, 880],
      [0.14, 1320],
    ] as const) {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start + offset)
      gain.gain.exponentialRampToValueAtTime(0.2, start + offset + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.16)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + 0.17)
    }
    return true
  } catch {
    return false
  }
}

/** One-shot gesture listeners that unlock the context; returns their cleanup. */
export function installCompletionCueAudioUnlock(target: Document = document): () => void {
  const unlock = (): void => unlockCompletionCueAudio()
  target.addEventListener('pointerdown', unlock, { capture: true, once: true })
  target.addEventListener('keydown', unlock, { capture: true, once: true })
  return () => {
    target.removeEventListener('pointerdown', unlock, { capture: true })
    target.removeEventListener('keydown', unlock, { capture: true })
  }
}

/** Test seam: forget and release the cached context. */
export function resetCompletionCueAudio(): void {
  const audio = context
  context = undefined
  if (audio !== undefined) void audio.close().catch(() => undefined)
}
