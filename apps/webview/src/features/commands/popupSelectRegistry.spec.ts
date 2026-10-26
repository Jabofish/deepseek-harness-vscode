import { describe, expect, it } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { commandDispatchKind, PopupSelectRegistry } from './popupSelectRegistry.js'

const execute: DynamicCommand = { name: 'clear', description: 'Clear the timeline' }
const leadingInput: DynamicCommand = {
  name: 'goal',
  description: 'Set a goal',
  input: { hint: '<goal>' },
}

describe('PopupSelectRegistry', () => {
  it('derives leadingInput and execute from the host descriptor when undecorated', () => {
    const registry = new PopupSelectRegistry()
    expect(commandDispatchKind(leadingInput, registry)).toBe('leadingInput')
    expect(commandDispatchKind(execute, registry)).toBe('execute')
  })
})
