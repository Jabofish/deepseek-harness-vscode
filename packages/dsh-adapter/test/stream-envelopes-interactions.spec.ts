import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { normalizeEnvelope, safeReason } from '../src/stream-envelopes.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

const approval = { type: 'approval/requested', sessionId: 's1', approvalId: 'approval', toolName: 'bash' }
const question = {
  type: 'question/requested',
  sessionId: 's1',
  questions: [{ id: 'question', question: 'Continue?' }],
}

describe('live interaction envelope identity', () => {
  it.each([approval, question])('requires the actual response identity for $type', (frame) => {
    for (const rpcId of [undefined, null, 1])
      expect(() => normalizeEnvelope({ rpcId, payload: frame })).toThrow(
        expect.objectContaining({ code: 'PROTOCOL_ERROR' }),
      )
    expect(() =>
      normalizeEnvelope({ payload: { ...frame, rpcId: 'payload-is-not-envelope-identity' } }),
    ).toThrow()
    expect(normalizeEnvelope({ rpcId: 'native-rpc', payload: frame })).toMatchObject(
      frame === approval
        ? { type: 'permission.requested', request: { id: 'approval', rpcId: 'native-rpc' } }
        : { type: 'question.requested', question: { id: 'question', rpcId: 'native-rpc' } },
    )
  })

  it('keeps history projection separate from an answerable live request', () => {
    expect(rc6Mapper.event('approval/requested', approval)).toMatchObject({
      type: 'permission.requested',
      request: { id: 'approval' },
    })
    expect(rc6Mapper.event('approval/requested', approval)).not.toHaveProperty('request.rpcId')
  })
})

describe('safeReason', () => {
  it('surfaces the WebSocket close code when the transport carried one', () => {
    const error = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'The alpha DSH multiplexed stream closed unexpectedly.',
      retryable: true,
      context: { closeCode: 1006 },
    })
    expect(safeReason(error)).toBe(
      'DSH event stream disconnected (BACKEND_UNREACHABLE, WebSocket close 1006).',
    )
  })

  it('omits the close code when the transport did not report one', () => {
    const error = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'The alpha DSH multiplexed stream closed unexpectedly.',
      retryable: true,
    })
    expect(safeReason(error)).toBe('DSH event stream disconnected (BACKEND_UNREACHABLE).')
  })
})
