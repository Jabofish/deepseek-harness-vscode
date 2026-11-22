// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  installCompletionCueAudioUnlock,
  playCompletionCueBell,
  resetCompletionCueAudio,
  unlockCompletionCueAudio,
} from './cue-audio.js'

interface AudioStub {
  readonly contextState: { value: string }
  readonly created: { value: number }
  readonly resume: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly starts: number[]
  readonly stops: number[]
  readonly frequencies: number[]
}

function stubAudio(initialState = 'running', behaviour: 'resolve' | 'pending' = 'resolve'): AudioStub {
  const stub: AudioStub = {
    contextState: { value: initialState },
    created: { value: 0 },
    resume: vi.fn<() => Promise<void>>(() => {
      if (behaviour === 'pending') return new Promise<void>(() => undefined)
      if (stub.contextState.value !== 'blocked') stub.contextState.value = 'running'
      return Promise.resolve()
    }),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    starts: [],
    stops: [],
    frequencies: [],
  }
  vi.stubGlobal(
    'AudioContext',
    class {
      get state(): string {
        return stub.contextState.value
      }
      currentTime = 1
      destination = {}
      resume = stub.resume
      close = stub.close
      constructor() {
        stub.created.value += 1
      }
      createOscillator(): object {
        const index = stub.starts.length
        stub.starts.push(-1)
        return {
          type: 'sine',
          frequency: {
            set value(value: number) {
              stub.frequencies[index] = value
            },
            get value(): number {
              return stub.frequencies[index] ?? 0
            },
          },
          connect: vi.fn(),
          start: (when: number) => {
            stub.starts[index] = when
          },
          stop: (when: number) => {
            stub.stops[index] = when
          },
        }
      }
      createGain(): object {
        return {
          connect: vi.fn(),
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
        }
      }
    },
  )
  return stub
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetCompletionCueAudio()
})

it('reports no sound when the Webview has no Web Audio', async () => {
  expect(await playCompletionCueBell()).toBe(false)
})

it('warms one shared context from a gesture and reuses it for the chime', async () => {
  const stub = stubAudio('suspended')
  unlockCompletionCueAudio()
  expect(stub.resume).toHaveBeenCalledTimes(1)
  expect(await playCompletionCueBell()).toBe(true)
  expect(await playCompletionCueBell()).toBe(true)
  expect(stub.frequencies.slice(0, 2)).toEqual([880, 1320])
  expect(stub.starts[0]).toBeCloseTo(1)
  expect(stub.starts[1]).toBeCloseTo(1.14)
  expect(stub.stops[0]).toBeCloseTo(1.17)
  expect(stub.stops[1]).toBeCloseTo(1.31)
  expect(stub.created.value).toBe(1)
  expect(stub.resume).toHaveBeenCalledTimes(1)
})

it('stays silent while playback policy keeps the context suspended', async () => {
  stubAudio('blocked')
  expect(await playCompletionCueBell()).toBe(false)
})

it('gives up when a blocked context never settles resume()', async () => {
  vi.useFakeTimers()
  stubAudio('suspended', 'pending')
  const playback = playCompletionCueBell()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await playback).toBe(false)
})

it('unlocks on the first gesture and releases both listeners', () => {
  const stub = stubAudio('suspended')
  const target = new EventTarget()
  const cleanup = installCompletionCueAudioUnlock(target as unknown as Document)
  expect(stub.resume).not.toHaveBeenCalled()
  target.dispatchEvent(new Event('pointerdown'))
  expect(stub.resume).toHaveBeenCalledTimes(1)
  target.dispatchEvent(new Event('keydown'))
  expect(stub.resume).toHaveBeenCalledTimes(1)
  cleanup()
  resetCompletionCueAudio()
  target.dispatchEvent(new Event('pointerdown'))
  target.dispatchEvent(new Event('keydown'))
  expect(stub.resume).toHaveBeenCalledTimes(1)
})

it('closes the cached context when the test seam resets it', () => {
  const stub = stubAudio()
  unlockCompletionCueAudio()
  resetCompletionCueAudio()
  expect(stub.close).toHaveBeenCalledTimes(1)
})
