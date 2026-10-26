import { describe, expect, it, vi } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { createPendingOpenBuffer } from './opening-state.js'

const message = (revision: number): HostMessage => ({
  type: 'event',
  name: 'session.transcript',
  sequence: revision,
  payload: { sessionId: 's', revision, nodes: [{ id: 'body', markdown: `Snapshot ${revision}` }] },
})

describe('bounded opening state', () => {
  it('keeps the latest snapshot, ignores stale/raw frames and releases failed opens', () => {
    const count = 3
    const buffer = createPendingOpenBuffer(vi.fn())
    const pending = buffer.create('s', 1)
    for (let i = 1; i <= count; i++) buffer.capture('s', message(i))
    buffer.capture('s', message(2))
    buffer.capture('s', {
      type: 'event',
      name: 'message.delta',
      sequence: 20_000,
      payload: { sessionId: 's', delta: 'raw' },
    })
    expect(pending.messages).toEqual([message(count)])
    expect(pending.overflow).toBe(false)
    buffer.settle(pending, false)
    const next = buffer.create('s', 2)
    expect(next.messages).toEqual([])
    expect(pending.messages).toEqual([])
  })

  it('invalidates overflowing control state and requests authority once after settlement', () => {
    const recover = vi.fn()
    const buffer = createPendingOpenBuffer(recover)
    const pending = buffer.create('s', 1)
    for (let i = 0; i < 200; i++)
      buffer.capture('s', {
        type: 'event',
        name: 'session.status',
        sequence: i,
        payload: { sessionId: 's', status: 'running' },
      })
    expect(pending.messages).toEqual([])
    expect(pending.overflow).toBe(true)
    expect(recover).not.toHaveBeenCalled()
    buffer.settle(pending, true)
    buffer.settle(pending, true)
    expect(recover).toHaveBeenCalled()
  })

  it('does not let a superseded open transfer or release the newer view', () => {
    const buffer = createPendingOpenBuffer(vi.fn())
    const old = buffer.create('s', 1)
    buffer.capture('s', message(1))
    const next = buffer.create('s', 2)
    expect(old.messages).toEqual([])
    buffer.capture('s', message(2))
    buffer.settle(old, false)
    expect(buffer.messagesAfterReplay(next)).toEqual([message(2)])
    buffer.clear()
    expect(next.messages).toEqual([])
    expect(buffer.capture('s', message(3))).toBeUndefined()
  })
})
