import { beforeEach, describe, expect, it } from 'vitest'
import {
  activateDraftOwner,
  clearDraftIf,
  readDraft,
  resetDraft,
  setDraft,
  transferDraftOwner,
} from './draft-store.js'

describe('composer draft ownership', () => {
  beforeEach(() => {
    resetDraft()
  })

  it('stores each conversation text separately instead of carrying it into the next chat', () => {
    activateDraftOwner('s1')
    setDraft('draft for one')
    activateDraftOwner('s2')
    expect(readDraft()).toBe('')
    setDraft('draft for two')
    activateDraftOwner('s1')
    expect(readDraft()).toBe('draft for one')
    activateDraftOwner('s2')
    expect(readDraft()).toBe('draft for two')
  })

  it('moves a pending composition draft into the session it opens', () => {
    activateDraftOwner('pending:1')
    setDraft('first message')
    transferDraftOwner('pending:1', 's3')
    activateDraftOwner('s3')
    expect(readDraft()).toBe('first message')
    clearDraftIf('pending:1', 'first message')
    expect(readDraft()).toBe('')
    activateDraftOwner('s3')
    expect(readDraft()).toBe('')
  })

  it('keeps text the user edited after submitting', () => {
    activateDraftOwner('s1')
    setDraft('sent text')
    activateDraftOwner('s2')
    activateDraftOwner('s1')
    setDraft('edited while the send settled')
    clearDraftIf('s1', 'sent text')
    expect(readDraft()).toBe('edited while the send settled')
  })
})
