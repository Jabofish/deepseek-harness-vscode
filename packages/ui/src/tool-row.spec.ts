import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import { classifyTool, isSpecializedTool, toolRowModel } from './components/ToolRow.js'

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
  it('classifies official built-ins while leaving unknown tools on the generic path', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('pwsh')).toBe('bash')
    expect(classifyTool('web_search')).toBe('search')
    expect(classifyTool('web_fetch')).toBe('web')
    expect(classifyTool('cordis_runtime_inspect')).toBe('read')
    expect(classifyTool('skill')).toBe('skill')
    expect(isSpecializedTool(tool())).toBe(true)
    expect(isSpecializedTool(tool({ name: 'cordis_run' }))).toBe(true)
    expect(isSpecializedTool(tool({ name: 'workspace_search' }))).toBe(false)
  })

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

  it('keeps running and failed states visible with useful summaries', () => {
    const running = toolRowModel(
      tool({
        name: 'bash',
        inputSummary: JSON.stringify({ description: 'Run the real check', command: 'pnpm check' }),
        status: 'running',
      }),
    )
    const failed = toolRowModel(
      tool({
        name: 'read',
        inputSummary: JSON.stringify({ path: 'missing.txt' }),
        status: 'failed',
        error: 'The file does not exist.',
      }),
    )

    expect(running).toMatchObject({ variant: 'bash', state: 'running', summary: 'Run the real check' })
    expect(failed).toMatchObject({
      variant: 'read',
      state: 'error',
      summary: 'missing.txt',
      errorSummary: 'The file does not exist.',
    })
  })

  it('summarizes todo progress and answered questions from their durable payloads', () => {
    const todo = toolRowModel(
      tool({
        name: 'todo_write',
        inputSummary: JSON.stringify({
          todos: [
            { subject: 'Inspect the stream', status: 'completed' },
            { subject: 'Verify the UI', status: 'in_progress' },
          ],
        }),
      }),
    )
    const question = toolRowModel(
      tool({
        name: 'ask_user_question',
        outputSummary: JSON.stringify({ answers: [{ selected: ['yes'] }, { selected: [] }] }),
      }),
    )

    expect(todo.summary).toBe('1/2 completed · Verify the UI')
    expect(question.summary).toBe('1/2 answered')
  })

  it('summarizes Python-style question calls without putting the payload in the row title', () => {
    const question = toolRowModel(
      tool({
        name: 'ask_user_question',
        inputSummary: "{'questions': [{'id': 'today_temperature', 'question': 'How warm?'}]}",
      }),
    )

    expect(question.summary).toBe('1 questions')
    expect(question.sections).toEqual([{ label: 'Questions', content: '• Question: How warm?' }])
  })

  it('renders the pinned structured read, search, and terminal result views', () => {
    const read = toolRowModel(
      tool({
        name: 'read',
        presentation: {
          phase: 'result',
          card: 'read',
          path: 'src/feature.ts',
          offset: 11,
          lines: [{ number: 11, text: 'export const answer = 42' }],
          totalLines: 42,
          lang: 'ts',
        },
      }),
    )
    const search = toolRowModel(
      tool({
        name: 'grep',
        presentation: {
          phase: 'result',
          card: 'search',
          shape: 'matches',
          files: [{ path: 'src/feature.ts', matches: [{ lineNumber: 11, line: 'answer' }] }],
          truncated: true,
          total: 4,
        },
      }),
    )
    const terminal = toolRowModel(
      tool({
        name: 'bash',
        presentation: {
          phase: 'result',
          card: 'terminal',
          output: 'all checks passed',
          exitCode: 0,
        },
      }),
    )

    expect(read.sections).toEqual([
      { label: 'File', content: 'src/feature.ts' },
      { label: 'Lines', content: '11: export const answer = 42' },
      { label: 'Total', content: '11–11 / 42' },
    ])
    expect(search.sections).toEqual([
      { label: 'Matches · src/feature.ts', content: '11: answer' },
      { label: 'Total', content: 'Showing 1 of 4' },
    ])
    expect(terminal.sections).toEqual([
      { label: 'Output', content: 'all checks passed' },
      { label: 'Exit status', content: '0' },
    ])
  })

  it('wraps a generic structured result instead of bypassing the presentation boundary', () => {
    const model = toolRowModel(
      tool({
        name: 'ask_user_question',
        presentation: {
          phase: 'result',
          card: 'generic',
          content: ["{'answers': [{'selected': ['温和 (15-25°C)']}]}"],
        },
      }),
    )

    expect(model.sections).toEqual([{ label: 'Result', content: 'Answers: • Selected: • 温和 (15-25°C)' }])
    expect(model.sections[0]?.content).not.toContain("{'answers'")
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
