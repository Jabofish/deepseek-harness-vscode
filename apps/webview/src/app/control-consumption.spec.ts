// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@dsh-vscode/webview-protocol'
import { ControlDelivery } from '../../../extension/src/view/control-delivery.js'
import { ProtocolClient } from './protocol-client.js'
import type { VsCodeApi } from '../vscode-api.js'

describe('host-to-store consumer feedback', () => {
  it('releases the next frame only after synchronous subscribers consumed the preceding frame', async () => {
    let sequence = 0
    const consumed: string[] = [],
      acknowledgements: number[] = []
    const api = {
      postMessage(envelope: { message: { type: string; requestId: string; payload: { sequence: number } } }) {
        const request = envelope.message
        if (request.type !== 'ui.events.ack') return
        acknowledgements.push(request.payload.sequence)
        delivery.acknowledge('s', request.payload.sequence)
        client.handle({
          protocolVersion: PROTOCOL_VERSION,
          message: { type: 'response', requestId: request.requestId, ok: true, payload: {} },
        })
      },
    } as unknown as VsCodeApi
    const client = new ProtocolClient(api)
    const delivery = new ControlDelivery(
      (_, event) => {
        client.handle({ protocolVersion: PROTOCOL_VERSION, message: event })
        return Promise.resolve(true)
      },
      () => ++sequence,
      () => true,
    )
    client.subscribe((message) => {
      if (message.type !== 'event') return
      expect(acknowledgements).toHaveLength(consumed.length)
      consumed.push(message.name)
    })
    try {
      const pending = ['question.requested', 'question.resolved', 'session.status'].map((name) =>
        delivery.enqueue('s', { type: 'event', name, sequence: 0, payload: {} }),
      )
      expect(consumed).toHaveLength(0)
      await Promise.all(pending)
      await vi.waitFor(() => expect(acknowledgements).toHaveLength(3))
      expect(consumed).toEqual(['question.requested', 'question.resolved', 'session.status'])
    } finally {
      delivery.dispose()
      client.dispose()
    }
  })
})
