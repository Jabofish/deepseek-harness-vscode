import { describe, expect, it } from 'vitest'
import { readOrderDrag } from './session-drawer-model.js'

describe('order drag payload', () => {
  const transfer = (value: string): DataTransfer => ({ getData: () => value }) as unknown as DataTransfer

  it('rejects the empty workspace id a non-reorderable row writes', () => {
    // Even a malformed transfer cannot reorder across an unknown workspace.
    expect(
      readOrderDrag(transfer(JSON.stringify({ kind: 'session', workspaceId: '', itemId: 's1' }))),
    ).toBeUndefined()
    expect(
      readOrderDrag(transfer(JSON.stringify({ kind: 'session', workspaceId: 'w1', itemId: 's1' }))),
    ).toEqual({ kind: 'session', workspaceId: 'w1', itemId: 's1' })
  })
})
