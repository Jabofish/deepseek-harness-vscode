import { describe, expect, it } from 'vitest'
import { sanitizePublicValue } from './public-value.js'

describe('editor companion public projections', () => {
  it('removes raw diagnostic and proposal payloads from live events and restored history', () => {
    const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
    const tool = {
      id: 'fixture-tool',
      name: 'vscode_get_diagnostics',
      status: 'completed',
      title: '/private/title',
      inputSummary: '/private/input',
      outputSummary: JSON.stringify({
        kind: 'diagnostics',
        relativePath: 'sample.ts',
        version: 1,
        capturedAt: '2026-01-01T00:00:00.000Z',
        cached: true,
        items: [
          {
            range,
            severity: 'error',
            message: 'private diagnostic body /private/secret',
            source: 'fixture',
            code: '1',
          },
        ],
        truncated: false,
      }),
      metadata: { bindingId: 'private_binding', endpoint: 'private_endpoint' },
      presentation: { content: ['private diagnostic body'] },
    }
    for (const payload of [{ type: 'tool.updated', tool }, { entries: [{ kind: 'tool', tool }] }]) {
      const result = JSON.stringify(sanitizePublicValue(payload))
      expect(result).toContain('1 cached diagnostics')
      expect(result).not.toMatch(/private|bindingId|endpoint|presentation/u)
    }
    const proposal = sanitizePublicValue({
      ...tool,
      name: 'vscode_propose_edit',
      outputSummary: JSON.stringify({
        kind: 'proposal',
        proposalId: 'private_proposal_1234',
        relativePath: 'sample.ts',
        status: 'pending',
        version: 2,
      }),
    })
    expect(JSON.stringify(proposal)).toContain('edit proposal pending')
    expect(JSON.stringify(proposal)).not.toContain('private')
  })
  it('uses fixed summaries for malformed companion results and preserves unrelated tools', () => {
    expect(
      sanitizePublicValue({
        name: 'vscode_get_diagnostics',
        id: 'id',
        status: 'failed',
        error: 'private error',
      }),
    ).toMatchObject({ outputSummary: 'Editor request failed or was denied.' })
    const tool = { name: 'other_tool', id: 'id', status: 'completed', outputSummary: 'ordinary result' }
    expect(sanitizePublicValue(tool)).toEqual(tool)
  })
})
