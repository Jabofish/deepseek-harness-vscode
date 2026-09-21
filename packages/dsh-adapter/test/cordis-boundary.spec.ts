import { describe, expect, it, vi } from 'vitest'
import { CordisClientBoundary } from '../src/versions/alpha162/cordis-boundary.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

const run = {
  requestId: 'run-1',
  agentId: 's1',
  pluginId: 'plugin-1',
  packageId: 'package-1',
  mode: 'start',
  name: 'Example',
  purpose: 'Example',
  requiresApproval: true,
}

describe('alpha162 Cordis client boundary', () => {
  it('shows a reject-only interaction and settles only after an explicit refusal', async () => {
    const boundary = new CordisClientBoundary()
    const frames = boundary.map('cordis/request-run', [run])
    const frame = frames?.[0] as Record<string, unknown>
    const event = rc6Mapper.event(String(frame.type), frame)
    expect(event).toMatchObject({
      type: 'permission.requested',
      request: {
        id: 'cordis-run:run-1',
        rpcId: 'cordis-run:run-1',
        sessionId: 's1',
        options: [{ id: 'rejected', label: 'Reject', kind: 'deny' }],
      },
    })
    const resolve = vi.fn().mockResolvedValue({ accepted: true })
    expect(resolve).not.toHaveBeenCalled()
    await expect(
      boundary.respond(
        'cordis-run:run-1',
        { ok: true, value: { sessionId: 's1', outcome: 'allowed-once' } },
        resolve,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(resolve).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    await expect(
      boundary.respond(
        'cordis-run:run-1',
        { ok: true, value: { sessionId: 's1', outcome: 'rejected' } },
        resolve,
        signal,
      ),
    ).resolves.toEqual({ accepted: true })
    expect(resolve).toHaveBeenCalledExactlyOnceWith('run-1', signal)
    expect(await boundary.respond('cordis-run:run-1', {}, resolve)).toBeUndefined()
  })

  it('reports inspect-query as requiring a real page, never a fabricated answer', () => {
    const boundary = new CordisClientBoundary()
    const frame = boundary.map('cordis/inspect-query', [
      { requestId: 'query-1', agentId: 's1' },
    ])?.[0] as Record<string, unknown>
    expect(rc6Mapper.event(String(frame.type), frame)).toMatchObject({
      type: 'notice',
      sessionId: 's1',
      level: 'error',
      text: expect.stringContaining('stop this turn') as unknown,
    })
  })

  it.each(['approved', 'rejected', 'cancelled', 'failed', 'completed'])(
    'clears requests resolved by another client: %s',
    async (outcome) => {
      const boundary = new CordisClientBoundary()
      boundary.map('cordis/request-run', [run])
      expect(boundary.map('cordis/request-run-resolved', [{ requestId: 'run-1', outcome }])).toMatchObject([
        { type: 'approval/resolved', sessionId: 's1', approvalId: 'cordis-run:run-1' },
      ])
      const resolve = vi.fn()
      expect(await boundary.respond('cordis-run:run-1', {}, resolve)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()
    },
  )

  it('keeps failed refusals retryable and releases all pending references on close', async () => {
    const boundary = new CordisClientBoundary()
    boundary.map('cordis/request-run', [run])
    const resolve = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ accepted: false })
    const rejection = { ok: true, value: { sessionId: 's1', outcome: 'rejected' } }
    await expect(boundary.respond('cordis-run:run-1', rejection, resolve)).rejects.toThrow('network')
    await expect(boundary.respond('cordis-run:run-1', rejection, resolve)).rejects.toMatchObject({
      code: 'STALE_INTERACTION',
    })
    boundary.clear()
    expect(await boundary.respond('cordis-run:run-1', rejection, resolve)).toBeUndefined()
  })

  it('rejects malformed frames and leaves unrelated events unchanged', () => {
    const boundary = new CordisClientBoundary()
    expect(() => boundary.map('cordis/request-run', [{ requestId: 'x' }])).toThrow()
    expect(() => boundary.map('cordis/inspect-query', [])).toThrow()
    expect(boundary.map('plugin-manager/changed', [])).toBeUndefined()
  })
})
