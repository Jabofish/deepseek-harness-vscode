import { describe, expect, it, vi } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { commandDispatchKind, PopupSelectRegistry } from './popupSelectRegistry.js'

const execute: DynamicCommand = { name: 'clear', description: 'Clear the timeline' }
const leadingInput: DynamicCommand = {
  name: 'goal',
  description: 'Set a goal',
  input: { hint: '<goal>' },
}

describe('PopupSelectRegistry', () => {
  it('decorates only registered bare commands and returns a disposer', () => {
    const registry = new PopupSelectRegistry()
    const onOpen = vi.fn()
    const dispose = registry.register({ command: 'Model', onOpen })
    expect(registry.get('model')?.onOpen).toBe(onOpen)
    expect(commandDispatchKind({ name: 'model', description: 'Select a model' }, registry)).toBe(
      'popupSelect',
    )
    dispose()
    expect(registry.get('model')).toBeUndefined()
  })

  it('derives leadingInput and execute from the host descriptor when undecorated', () => {
    const registry = new PopupSelectRegistry()
    expect(commandDispatchKind(leadingInput, registry)).toBe('leadingInput')
    expect(commandDispatchKind(execute, registry)).toBe('execute')
  })

  it('rejects duplicate and malformed registrations', () => {
    const registry = new PopupSelectRegistry()
    registry.register({ command: 'plan', onOpen: vi.fn() })
    expect(() => registry.register({ command: 'PLAN', onOpen: vi.fn() })).toThrow(/already registered/u)
    expect(() => registry.register({ command: 'not valid', onOpen: vi.fn() })).toThrow(/valid command/u)
  })
})
