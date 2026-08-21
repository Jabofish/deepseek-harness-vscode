import { describe, expect, it } from 'vitest'

import type { ToolCallView } from '@dsh-vscode/domain'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { rc8Mapper } from '../src/versions/rc8/mapper.js'

function mapped(
  mapper: typeof rc6Mapper,
  name: 'tool/call' | 'tool/result',
  data: Record<string, unknown>,
): ToolCallView {
  const event = mapper.event(name, { sessionId: 's1', data })
  if (event.type !== 'tool.updated') throw new Error(`Expected tool.updated, got ${event.type}`)
  return event.tool
}

describe('DSH tool presentation contract', () => {
  it('maps rc.8 terminal calls and read results into bounded domain views', () => {
    const call = mapped(rc8Mapper, 'tool/call', {
      callId: 'call-terminal',
      name: 'bash',
      arguments: JSON.stringify({ command: 'pnpm check' }),
      view: {
        for: 'call',
        view: {
          card: 'terminal',
          title: 'pnpm check',
          description: 'Run the repository checks',
          cwd: 'D:\\CS\\deepseek-harness-vscode',
        },
      },
    })
    expect(call.presentation).toEqual({
      phase: 'call',
      card: 'terminal',
      title: 'pnpm check',
      description: 'Run the repository checks',
      cwd: 'D:\\CS\\deepseek-harness-vscode',
    })

    const result = mapped(rc8Mapper, 'tool/result', {
      callId: 'call-read',
      name: 'read',
      message: { content: 'model-facing read result' },
      view: {
        for: 'result',
        view: {
          card: 'read',
          path: 'src/feature.ts',
          offset: 11,
          lines: [
            { number: 11, text: 'export const answer = 42' },
            { number: 12, text: '' },
          ],
          totalLines: 42,
          lang: 'ts',
          content: [{ type: 'text', text: 'export const answer = 42' }],
        },
      },
    })
    expect(result.presentation).toEqual({
      phase: 'result',
      card: 'read',
      path: 'src/feature.ts',
      offset: 11,
      lines: [
        { number: 11, text: 'export const answer = 42' },
        { number: 12, text: '' },
      ],
      totalLines: 42,
      lang: 'ts',
      content: ['export const answer = 42'],
    })
  })

  it('maps diff, search, and web result cards without exposing protocol identifiers', () => {
    const diff = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-diff',
      name: 'edit',
      view: {
        for: 'result',
        view: {
          card: 'diff',
          title: 'Edit feature.ts',
          diffs: [{ path: 'src/feature.ts', oldText: 'old', newText: 'new' }],
        },
      },
    })
    const search = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-search',
      name: 'grep',
      view: {
        for: 'result',
        view: {
          card: 'search',
          shape: 'matches',
          files: [{ path: 'src/feature.ts', matches: [{ lineNumber: 4, line: 'answer' }] }],
          truncated: true,
          total: 3,
        },
      },
    })
    const web = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-web',
      name: 'web_search',
      view: {
        for: 'result',
        view: {
          card: 'web',
          kind: 'search',
          sources: [{ url: 'https://example.test/source', title: 'Source', snippet: 'Excerpt' }],
          answer: 'A concise answer',
          truncated: false,
        },
      },
    })

    expect(diff.presentation).toMatchObject({
      phase: 'result',
      card: 'diff',
      diffs: [{ path: 'src/feature.ts', oldText: 'old', newText: 'new' }],
    })
    expect(search.presentation).toMatchObject({
      phase: 'result',
      card: 'search',
      shape: 'matches',
      files: [{ path: 'src/feature.ts', matches: [{ lineNumber: 4, line: 'answer' }] }],
      truncated: true,
      total: 3,
    })
    expect(web.presentation).toMatchObject({
      phase: 'result',
      card: 'web',
      kind: 'search',
      sources: [{ url: 'https://example.test/source', title: 'Source', snippet: 'Excerpt' }],
    })
    expect(JSON.stringify(web.presentation)).not.toContain('call-web')
  })

  it('keeps rc.6 no-view and malformed/future cards on the generic path', () => {
    const legacy = mapped(rc6Mapper, 'tool/result', {
      callId: 'legacy',
      name: 'custom_tool',
      message: { content: 'legacy result' },
    })
    const future = mapped(rc6Mapper, 'tool/result', {
      callId: 'future',
      name: 'custom_tool',
      view: { for: 'result', view: { card: 'future-card', message: 'ignore me' } },
    })
    const generic = mapped(rc6Mapper, 'tool/call', {
      callId: 'generic',
      name: 'custom_tool',
      view: {
        for: 'call',
        view: { card: 'generic', rawInput: { path: 'safe.txt', token: 'must-not-render' } },
      },
    })

    expect(legacy.presentation).toBeUndefined()
    expect(future.presentation).toBeUndefined()
    expect(generic.presentation).toMatchObject({ phase: 'call', card: 'generic' })
    expect(JSON.stringify(generic.presentation)).not.toContain('must-not-render')
    expect(JSON.stringify(generic.presentation)).toContain('safe.txt')
  })
})
