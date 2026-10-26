import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import { formatToolText, toolPresentation } from './tool-presentation.js'

function tool(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: 'call-1',
    name: 'subagent',
    category: 'tool',
    title: 'Tool',
    status: 'completed',
    metadata: {},
    ...overrides,
  }
}

describe('toolPresentation', () => {
  it('turns a subagent request and transport result into user-facing sections', () => {
    const presentation = toolPresentation(
      tool({
        inputSummary: JSON.stringify({
          description: '子代理功能演示任务',
          prompt: '列出喜欢的语言并完成计算。',
        }),
        outputSummary: JSON.stringify({
          source: { kind: 'tool', callId: 'call-secret' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-secret',
              content: [{ type: 'text', text: 'started subagent child-secret-id' }],
              isError: false,
            },
          ],
          role: 'user',
          id: 'message-secret-id',
        }),
      }),
    )

    expect(presentation).toEqual({
      title: 'Subagent',
      summary: 'Task · 子代理功能演示任务',
      request: [
        { label: 'Task', content: '子代理功能演示任务' },
        { label: 'Instructions', content: '列出喜欢的语言并完成计算。' },
      ],
      response: [{ label: 'Result', content: 'Subagent started successfully.' }],
    })
    expect(JSON.stringify(presentation)).not.toContain('call-secret')
    expect(JSON.stringify(presentation)).not.toContain('message-secret-id')
  })

  it('formats unknown tool objects without exposing protocol identifiers or raw JSON', () => {
    const presentation = toolPresentation(
      tool({
        name: 'workspace_search',
        title: 'Search workspace',
        inputSummary: JSON.stringify({
          query: 'ToolCard',
          requestId: 'request-secret',
          options: { caseSensitive: true, sessionId: 'session-secret' },
        }),
        outputSummary: JSON.stringify({
          content: [{ type: 'text', text: '3 matches' }],
          role: 'user',
        }),
      }),
    )

    expect(presentation.title).toBe('Search workspace')
    expect(presentation.request).toEqual([
      { label: 'Query', content: 'ToolCard' },
      { label: 'Options · Case sensitive', content: 'true' },
    ])
    expect(presentation.response).toEqual([{ label: 'Result', content: '3 matches' }])
    expect(JSON.stringify(presentation)).not.toContain('request-secret')
    expect(JSON.stringify(presentation)).not.toContain('session-secret')
  })

  it('wraps Python-style question payloads instead of exposing native object reprs', () => {
    const presentation = toolPresentation(
      tool({
        name: 'ask_user_question',
        title: 'Question',
        inputSummary: "{'questions': [{'id': 'today_temperature', 'question': 'How warm?'}]}",
        outputSummary: "{'answers': [{'id': 'today_temperature', 'selected': ['温和 (15-25°C)']}]} ",
      }),
    )

    expect(presentation.request).toEqual([{ label: 'Questions', content: '• Question: How warm?' }])
    expect(presentation.response).toEqual([{ label: 'Answers', content: '• Selected: • 温和 (15-25°C)' }])
    expect(JSON.stringify(presentation)).not.toContain("{'answers'")
  })

  it('does not leak a structured payload nested inside a tool-result text block', () => {
    const presentation = toolPresentation(
      tool({
        name: 'question',
        title: 'question',
        outputSummary: JSON.stringify({
          content: [{ type: 'text', text: '{"answers":[{"selected":["yes"]}]}' }],
        }),
      }),
    )

    expect(presentation.response[0]?.content).toContain('yes')
    expect(presentation.response[0]?.content).not.toContain('{"answers"')
  })
})

describe('formatToolText', () => {
  it('keeps the trailing text that follows an embedded structured literal', () => {
    // A tool error whose actionable tail sits after a bracketed list must not
    // lose that tail: the reader needs to know which value was rejected.
    expect(formatToolText('Expected one of [read, write] but got "x"')).toBe(
      'Expected one of\n• read\n• write\nbut got "x"',
    )
  })

  it('leaves prose with an unbalanced bracket untouched', () => {
    const source = 'Use [Ctrl+C to copy'
    expect(formatToolText(source)).toBe(source)
  })

  it('retains every entry of a long structured output list', () => {
    const presentation = toolPresentation(
      tool({
        name: 'workspace_search',
        title: 'Search',
        outputSummary: JSON.stringify({ rows: Array.from({ length: 100 }, (_, index) => ({ index })) }),
      }),
    )

    const content = presentation.response[0]?.content ?? ''
    expect(content).toContain('• Index: 63')
    expect(content).toContain('• Index: 64')
    expect(content).toContain('• Index: 99')
    expect(content).not.toContain('more)')
  })
})
