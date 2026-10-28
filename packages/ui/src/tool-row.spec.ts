import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import { toolRowModel } from './components/ToolRow.js'

function tool(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: 'call-1',
    name: 'skill',
    category: 'tool',
    title: 'Tool',
    status: 'completed',
    metadata: {},
    ...overrides,
  }
}

describe('ToolRow', () => {
  it('projects a real skill result to bounded visible instructions without protocol ids', () => {
    const model = toolRowModel(
      tool({
        inputSummary: JSON.stringify({ name: 'editing-cordis-compositions' }),
        outputSummary: JSON.stringify({
          source: { kind: 'tool', callId: 'call-secret' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-secret',
              content: [{ type: 'text', text: '<skill_content>Use the editing workflow.</skill_content>' }],
            },
          ],
          id: 'message-secret',
        }),
      }),
    )

    expect(model.variant).toBe('skill')
    expect(model.state).toBe('ok')
    expect(model.summary).toBe('editing-cordis-compositions')
    expect(model.sections).toEqual([
      { label: 'Instructions', content: '<skill_content>Use the editing workflow.</skill_content>' },
    ])
    expect(JSON.stringify(model)).not.toContain('call-secret')
    expect(JSON.stringify(model)).not.toContain('message-secret')
  })

  it('uses safe localized fallback copy when an Auto review denial has no displayable reason', () => {
    const model = toolRowModel(
      tool({ status: 'failed', autoReviewDenial: { reason: ' \n ' }, error: 'raw error should stay hidden' }),
    )

    expect(model).toMatchObject({
      state: 'error',
      summary: 'Rejected by Auto review',
      errorSummary: 'Rejected by Auto review',
      sections: [],
    })
    expect(model.autoReviewOutput).toContain('Tool was not executed.')
    expect(model.autoReviewOutput).toContain('Manual approval is required to continue.')
    expect(model.autoReviewOutput).toContain('Auto review did not authorize this action')
    expect(JSON.stringify(model)).not.toContain('raw error should stay hidden')
  })

  it('marks a settled shell row failed when its own exit status says so', () => {
    const row = (presentation: ToolCallView['presentation']): ReturnType<typeof toolRowModel> =>
      toolRowModel(
        tool({
          name: 'bash',
          status: 'completed',
          inputSummary: JSON.stringify({ description: 'Run the checks', command: 'pnpm check' }),
          ...(presentation === undefined ? {} : { presentation }),
        }),
      )

    const failing = row({ phase: 'result', card: 'terminal', output: 'boom', exitCode: 2 })
    const killed = row({ phase: 'result', card: 'terminal', output: 'gone', signal: 'SIGTERM' })
    const clean = row({ phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 })
    const quiet = row({ phase: 'result', card: 'terminal', output: 'no status stated' })

    expect(failing.state).toBe('error')
    // The card states the exit; the row must not echo the bare number back as
    // if it were the failure text.
    expect(failing.errorSummary).toBeUndefined()
    expect(failing.summary).toBe('Run the checks')
    expect(killed.state).toBe('error')
    expect(clean.state).toBe('ok')
    expect(quiet.state).toBe('ok')
  })

  it('keeps a real empty read window explicit instead of rendering a negative range', () => {
    const model = toolRowModel(
      tool({
        name: 'read',
        presentation: {
          phase: 'result',
          card: 'read',
          path: 'src/empty.ts',
          offset: 21,
          lines: [],
          totalLines: 20,
        },
      }),
    )

    expect(model.sections).toEqual([
      { label: 'File', content: 'src/empty.ts' },
      { label: 'Total', content: 'No lines / 20' },
    ])
  })
})
