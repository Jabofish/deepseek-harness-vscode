import { describe, expect, it } from 'vitest'
import { isTearOffDrag, readOrderDrag, type SessionDragOutcome } from './session-drawer-model.js'

function outcome(overrides: Partial<SessionDragOutcome> = {}): SessionDragOutcome {
  return { leftPanel: false, reordered: false, dropEffect: undefined, ...overrides }
}

describe('session row tear-off', () => {
  it('accepts a drag that left the panel and was dropped on nothing', () => {
    expect(isTearOffDrag(outcome({ leftPanel: true, dropEffect: 'none' }))).toBe(true)
  })

  it.each([
    ['the pointer never left the panel', outcome({ dropEffect: 'none' })],
    ['the drag was consumed by a reorder', outcome({ leftPanel: true, reordered: true, dropEffect: 'none' })],
    ['a drop target accepted the drag', outcome({ leftPanel: true, dropEffect: 'move' })],
    ['the browser reported no drop effect', outcome({ leftPanel: true })],
    ['the browser reported an empty drop effect', outcome({ leftPanel: true, dropEffect: '' })],
  ])('refuses a drag where %s', (_name, drag) => {
    expect(isTearOffDrag(drag)).toBe(false)
  })
})

describe('order drag payload', () => {
  const transfer = (value: string): DataTransfer => ({ getData: () => value }) as unknown as DataTransfer

  it('rejects the empty workspace id a non-reorderable row writes', () => {
    // Every row is draggable now; only rows that may reorder carry a workspace
    // the drop handler accepts, so a drag in "updated" order cannot reorder.
    expect(
      readOrderDrag(transfer(JSON.stringify({ kind: 'session', workspaceId: '', itemId: 's1' }))),
    ).toBeUndefined()
    expect(
      readOrderDrag(transfer(JSON.stringify({ kind: 'session', workspaceId: 'w1', itemId: 's1' }))),
    ).toEqual({ kind: 'session', workspaceId: 'w1', itemId: 's1' })
  })
})
