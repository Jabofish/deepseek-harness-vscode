import { describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'

import { updateEditorContextAvailabilityKeys } from './context-keys.js'

describe('updateEditorContextAvailabilityKeys', () => {
  it('publishes availability, skips unchanged values, and clears stale entries', async () => {
    const calls: unknown[][] = []
    const commands = {
      executeCommand: (...args: unknown[]): Promise<undefined> => {
        calls.push(args)
        return Promise.resolve(undefined)
      },
    } as unknown as typeof vscode.commands

    await updateEditorContextAvailabilityKeys(commands, ['selection', 'symbol'])

    expect(calls).toEqual([
      ['setContext', 'dsh.editorContext.selectionAvailable', true],
      ['setContext', 'dsh.editorContext.fileAvailable', false],
      ['setContext', 'dsh.editorContext.symbolAvailable', true],
      ['setContext', 'dsh.editorContext.diagnosticAvailable', false],
    ])

    calls.length = 0
    await updateEditorContextAvailabilityKeys(commands, ['selection', 'symbol'])
    expect(calls).toEqual([])

    await updateEditorContextAvailabilityKeys(commands, [])
    expect(calls).toEqual([
      ['setContext', 'dsh.editorContext.selectionAvailable', false],
      ['setContext', 'dsh.editorContext.symbolAvailable', false],
    ])
  })
})
