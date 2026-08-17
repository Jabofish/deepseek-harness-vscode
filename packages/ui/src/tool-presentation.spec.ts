import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import { toolPresentation } from './tool-presentation.js'

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
})
