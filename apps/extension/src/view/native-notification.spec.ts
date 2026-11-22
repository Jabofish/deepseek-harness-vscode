import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { showNativeNotification } from './native-notification.js'

class FakeChild extends EventEmitter {
  public readonly kill = vi.fn()
}

function notifier(outcome: { readonly code?: number; readonly error?: boolean } = { code: 0 }): {
  readonly spawn: ReturnType<typeof vi.fn>
  readonly child: FakeChild
} {
  const child = new FakeChild()
  const spawn = vi.fn(() => {
    queueMicrotask(() => {
      if (outcome.error === true) child.emit('error', new Error('not found'))
      else child.emit('exit', outcome.code ?? 0)
    })
    return child
  })
  return { spawn, child }
}

it('uses notify-send with fixed arguments on Linux', async () => {
  const { spawn, child } = notifier()
  expect(
    await showNativeNotification('JaboDSH', 'Response is ready.', {
      platform: 'linux',
      spawn: spawn as never,
    }),
  ).toBe(true)
  expect(spawn).toHaveBeenCalledWith(
    'notify-send',
    ['--app-name=JaboDSH', '--urgency=normal', '--icon=dialog-information', 'JaboDSH', 'Response is ready.'],
    { stdio: 'ignore' },
  )
  expect(child.kill).not.toHaveBeenCalled()
})

it('uses osascript on macOS and escapes the fixed text', async () => {
  const { spawn } = notifier()
  expect(
    await showNativeNotification('Jabo "DSH"', 'Line\\one', {
      platform: 'darwin',
      spawn: spawn as never,
    }),
  ).toBe(true)
  expect(spawn).toHaveBeenCalledWith(
    'osascript',
    ['-e', 'display notification "Line\\\\one" with title "Jabo \\"DSH\\""'],
    { stdio: 'ignore' },
  )
})

it('does not spawn on platforms without a notifier', async () => {
  const { spawn } = notifier()
  expect(await showNativeNotification('JaboDSH', 'Ready', { platform: 'win32', spawn: spawn as never })).toBe(
    false,
  )
  expect(spawn).not.toHaveBeenCalled()
})

it('reports a missing notifier and a non-zero exit', async () => {
  for (const outcome of [{ error: true }, { code: 1 }]) {
    const { spawn } = notifier(outcome)
    expect(
      await showNativeNotification('JaboDSH', 'Ready', { platform: 'linux', spawn: spawn as never }),
    ).toBe(false)
  }
})

it('reports a synchronous spawn failure', async () => {
  const spawn = vi.fn(() => {
    throw new Error('invalid arguments')
  })
  expect(await showNativeNotification('JaboDSH', 'Ready', { platform: 'linux', spawn })).toBe(false)
})

it('gives up when the notifier never exits', async () => {
  vi.useFakeTimers()
  const child = new FakeChild()
  const spawn = vi.fn(() => child)
  try {
    const pending = showNativeNotification('JaboDSH', 'Ready', {
      platform: 'linux',
      spawn: spawn as never,
      timeoutMs: 100,
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(await pending).toBe(false)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  } finally {
    vi.useRealTimers()
  }
})
