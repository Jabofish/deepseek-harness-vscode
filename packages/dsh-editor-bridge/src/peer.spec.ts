import { describe, expect, it } from 'vitest'
import { editorPeerId } from './peer.js'
describe('editor peer negotiation across Gateway generations', () => {
  it('supports authenticated pre-Principal peers and owner principals, refusing restricted or malformed identities', () => {
    expect(editorPeerId({ id: 'legacy-peer', ctx: {} })).toBe('legacy-peer')
    expect(editorPeerId({ id: 'owner-peer', principal: { kind: 'owner' } })).toBe('owner-peer')
    for (const peer of [
      undefined,
      {},
      { id: '' },
      { id: 'x', principal: undefined },
      { id: 'x', principal: { kind: 'session' } },
    ])
      expect(editorPeerId(peer)).toBeUndefined()
  })
})
