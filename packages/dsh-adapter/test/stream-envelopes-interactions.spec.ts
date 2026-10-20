import { describe, expect, it } from 'vitest'
import { normalizeEnvelope } from '../src/stream-envelopes.js'
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
