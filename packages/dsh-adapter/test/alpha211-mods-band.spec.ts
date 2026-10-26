import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import {
  Alpha211ModsBandRepository,
  mapModsBandSnapshot,
} from '../src/versions/alpha211/mods-band-repository.js'

// Pinned dsh-v0.2.1-alpha.1 5badb150: experimental/claude-code-mods/{types,surfaces}.ts.
const drawing = (generation = 1): unknown => ({
  generation,
  tree: [
    {
      type: 'Box',
      props: { flexDirection: 'row', gap: 2 },
      children: [
        { type: 'Text', props: { bold: true, color: 'green' }, children: ['Ready'] },
        { type: 'Button', props: { label: 'Continue', hotkey: 'c' }, actionId: 'a0', children: [] },
      ],
    },
  ],
})
afterEach(() => vi.useRealTimers())

function fixture(frames: readonly unknown[] = [drawing()]): {
  repository: Alpha211ModsBandRepository
  released: Mock<() => void>
  remoteRequest: Mock<() => Promise<unknown>>
  openRemoteStream: Mock<
    (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => AsyncGenerator<unknown>
  >
} {
  const released = vi.fn()
  const remoteRequest = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ ok: true, value: drawing(2) }))
  const openRemoteStream = vi.fn((_endpoint: string, _args: Record<string, unknown>, signal?: AbortSignal) =>
    (async function* () {
      try {
        for (const frame of frames) yield frame
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      } finally {
        released()
      }
    })(),
  )
  return {
    repository: new Alpha211ModsBandRepository({ remoteRequest, openRemoteStream }, 100),
    remoteRequest,
    openRemoteStream,
    released,
  }
}

describe('alpha211 optional mod drawing', () => {
  it('uses verified Agent args, releases the initial watch, and presses only advertised actions', async () => {
    const f = fixture()
    expect((await f.repository.read('s1')).snapshot?.generation).toBe(1)
    expect(f.openRemoteStream).toHaveBeenCalledWith(
      'claudeCodeMods/watchBand',
      { agentId: 's1' },
      expect.any(AbortSignal),
    )
    expect(f.released).toHaveBeenCalledTimes(1)
    await expect(f.repository.press('s1', 0, 'a0')).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    await expect(f.repository.press('other', 1, 'a0')).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    await expect(f.repository.press('s1', 1, 'unknown')).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    expect(f.remoteRequest).not.toHaveBeenCalled()
    expect((await f.repository.press('s1', 1, 'a0')).generation).toBe(2)
    expect(f.remoteRequest).toHaveBeenCalledWith(
      'claudeCodeMods/pressBand',
      { agentId: 's1', generation: 1, actionId: 'a0' },
      expect.any(AbortSignal),
    )
    await f.repository.close()
    await expect(f.repository.press('s1', 2, 'a0')).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
  })

  it('hides an absent optional Remote while preserving protocol and business failures', async () => {
    for (const code of ['CAPABILITY_UNAVAILABLE', 'PERMISSION_DENIED', 'PROTOCOL_ERROR'] as const) {
      const repository = new Alpha211ModsBandRepository({
        remoteRequest: () => Promise.reject(new Error('unexpected')),
        openRemoteStream: async function* () {
          yield await Promise.reject(new AppError({ code, message: 'safe', retryable: false }))
        },
      })
      if (code === 'CAPABILITY_UNAVAILABLE')
        await expect(repository.read('s1')).resolves.toEqual({ available: false, snapshot: null })
      else await expect(repository.read('s1')).rejects.toMatchObject({ code })
      await repository.close()
    }
    const absent = new Alpha211ModsBandRepository({
      remoteRequest: () => Promise.reject(new Error('unexpected')),
      openRemoteStream: async function* () {
        yield await Promise.reject(
          new AppError({
            code: 'INVALID_CONFIGURATION',
            message: 'private gateway text',
            retryable: false,
            context: { rpcMethod: 'alpha stream', rpcCode: 'unknown-command' },
          }),
        )
      },
    })
    await expect(absent.read('s1')).resolves.toEqual({ available: false, snapshot: null })
    await absent.close()
  })

  it('projects only safe props and redacts addresses, paths, credentials and controls', () => {
    const result = mapModsBandSnapshot({
      generation: 2,
      tree: [
        {
          type: 'Text',
          props: { html: '<script>unsafe</script>', color: 'url(secret)', bold: true },
          children: [
            'token=fixture-secret C:\\private\\file http://127.0.0.1:2222/path\u001b',
            'PID=12345 cookie=session=fixture-cookie; auth=fixture-token',
          ],
        },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/fixture-|12345|private|127\.0\.0\.1|script|url\(/)
    expect(result.tree?.[0]).toMatchObject({ kind: 'text', bold: true })
  })

  it.each([
    { generation: -1, tree: null },
    { generation: 1, tree: ['x'.repeat(4097)] },
    { generation: 1, tree: Array.from({ length: 513 }, () => '') },
    { generation: 1, tree: [{ type: 'HTML', props: {}, children: [] }] },
    {
      generation: 1,
      tree: [{ type: 'Button', props: { label: 'x' }, children: [], actionId: 'http://bad' }],
    },
    { generation: 1, tree: null, body: 'PRIVATE' },
  ])('rejects malformed/oversized snapshots', (value) => {
    expect(() => mapModsBandSnapshot(value)).toThrow(AppError)
  })
})
