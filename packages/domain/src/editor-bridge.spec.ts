import { describe, expect, it } from 'vitest'
import { isEditorStateSnapshot } from './editor-bridge.js'

const snapshot = {
  relativePath: 'src/sample.ts',
  languageId: 'typescript',
  documentVersion: 1,
  dirty: false,
  selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
  diagnostics: { errors: 0, warnings: 1 },
  capturedAt: '2026-01-01T00:00:00.000Z',
}
describe('editor metadata allowlist', () => {
  it('accepts a bounded metadata snapshot and rejects private fields, paths and malformed positions', () => {
    expect(isEditorStateSnapshot(snapshot)).toBe(true)
    for (const patch of [
      { relativePath: '../private' },
      { relativePath: 'C:/private' },
      { text: 'private body' },
      { diagnostics: { errors: 0, warnings: 0, message: 'private diagnostic' } },
      { selection: { start: { line: 0, column: 0 }, end: { line: 1, column: 1 } } },
      { documentVersion: NaN },
      { capturedAt: 'invalid' },
    ])
      expect(isEditorStateSnapshot({ ...snapshot, ...patch })).toBe(false)
  })
})
