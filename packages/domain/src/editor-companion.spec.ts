import { describe, expect, it } from 'vitest'
import {
  editorCapability,
  editorValueMatches,
  isEditorCompanionCapabilities,
  isEditorCompanionDescription,
  isEditorCompanionPoll,
  isEditorCompanionRequest,
  isEditorCompanionValue,
} from './editor-companion.js'

describe('editor companion v2 boundaries', () => {
  it('accepts immediate applied receipts and legacy pending receipts without accepting mismatched edits', () => {
    const request = { kind: 'propose', path: 'a.ts', expectedVersion: 5, edits: [] } as const
    const receipt = {
      kind: 'proposal',
      relativePath: 'a.ts',
      proposalId: 'fixture_proposal_1234',
      version: 6,
      status: 'applied',
      saved: true,
    } as const
    expect(isEditorCompanionValue(receipt)).toBe(true)
    expect(editorValueMatches(request, receipt)).toBe(true)
    expect(editorValueMatches(request, { ...receipt, version: 8 })).toBe(true)
    expect(editorValueMatches(request, { ...receipt, version: 5 })).toBe(true)
    expect(editorValueMatches(request, { ...receipt, version: 4 })).toBe(false)
    expect(editorValueMatches(request, { ...receipt, relativePath: 'other.ts' })).toBe(false)
    expect(editorValueMatches(request, { ...receipt, status: 'reverted' })).toBe(false)
    expect(editorValueMatches(request, { ...receipt, status: 'pending', version: 5 })).toBe(true)
    expect(editorValueMatches(request, { ...receipt, status: 'pending' })).toBe(false)
    expect(editorValueMatches(request, { ...receipt, status: 'stale' })).toBe(true)
    expect(isEditorCompanionValue({ ...receipt, status: 'uncertain', saved: false })).toBe(true)
    expect(editorValueMatches(request, { ...receipt, status: 'uncertain', saved: false })).toBe(true)
    expect(editorValueMatches(request, { ...receipt, status: 'uncertain', version: 4 })).toBe(false)
    expect(isEditorCompanionValue({ ...receipt, saved: 'yes' })).toBe(false)
    expect(isEditorCompanionRequest({ kind: 'open' })).toBe(true)
    expect(isEditorCompanionRequest({ kind: 'document', startColumn: 2 })).toBe(true)
    expect(isEditorCompanionRequest({ kind: 'document', startColumn: 0 })).toBe(false)
  })
  it('validates each operation and its distinct permission without accepting arbitrary commands or paths', () => {
    expect(
      isEditorCompanionRequest({ kind: 'document', path: 'src/main.ts', startLine: 2, endLine: 4 }),
    ).toBe(true)
    expect(editorCapability({ kind: 'state' })).toBeUndefined()
    expect(editorCapability({ kind: 'document' })).toBe('content')
    expect(editorCapability({ kind: 'propose', path: 'a.ts', expectedVersion: 1, edits: [] })).toBe('edit')
    for (const request of [
      { kind: 'document', path: '../private' },
      { kind: 'document', path: 'C:/private' },
      { kind: 'selection', command: 'anything' },
      { kind: 'document', startLine: undefined },
      { kind: 'definitions', line: 0, column: 1 },
      { kind: 'propose', path: 'a.ts', expectedVersion: 0, edits: [] },
    ])
      expect(isEditorCompanionRequest(request)).toBe(false)
    // Ranges are clamped by the Host, so inverted and zero-based values remain usable requests.
    expect(isEditorCompanionRequest({ kind: 'document', startLine: 4, endLine: 2 })).toBe(true)
    expect(isEditorCompanionRequest({ kind: 'document', startLine: 0, endLine: 0 })).toBe(true)
    expect(isEditorCompanionCapabilities(['content', 'content'])).toBe(false)
    expect(isEditorCompanionCapabilities(['shell'])).toBe(false)
  })
  it('bounds edits and validates complete operation results and cancellation events', () => {
    const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
    expect(
      isEditorCompanionRequest({
        kind: 'propose',
        path: 'a.ts',
        expectedVersion: 1,
        edits: [{ range, text: 'new' }],
      }),
    ).toBe(true)
    expect(
      isEditorCompanionRequest({
        kind: 'propose',
        path: 'a.ts',
        expectedVersion: 1,
        edits: [{ range, text: 'x'.repeat(65_537) }],
      }),
    ).toBe(false)
    const value = {
      kind: 'document',
      relativePath: 'a.ts',
      languageId: 'typescript',
      version: 2,
      dirty: true,
      range,
      text: 'new',
      truncated: false,
    }
    expect(isEditorCompanionValue(value)).toBe(true)
    expect(isEditorCompanionValue({ ...value, endpoint: 'private' })).toBe(false)
    expect(
      isEditorCompanionValue({
        kind: 'locations',
        items: [{ relativePath: '/private', range }],
        truncated: false,
        excluded: 0,
      }),
    ).toBe(false)
    expect(isEditorCompanionPoll({ kind: 'cancel', requestId: 'fixture_request_1234' })).toBe(true)
    expect(
      isEditorCompanionDescription({
        protocolVersion: 3,
        packageVersion: '0.2.0',
        capabilities: [],
        maxGrants: 16,
      }),
    ).toBe(false)
  })
})
