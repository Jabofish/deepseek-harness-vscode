import { describe, expect, it } from 'vitest'

import type { ToolCallView } from '@dsh-vscode/domain'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

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
    const call = mapped(rc6Mapper, 'tool/call', {
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

    const result = mapped(rc6Mapper, 'tool/result', {
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

  it('keeps a removal-only hunk whose new text is legitimately empty', () => {
    // The pinned DSH builds a hunk diff with `newLines.join("\n")`, so a hunk
    // that only deletes lines has `newText: ''`; `edit`/`write`/`str_replace`
    // call views do the same when a change clears the file. Dropping those
    // diffs loses the file from the tool card and from the change review, and
    // makes the "deleted" status unreachable.
    const removal = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-removal',
      name: 'edit',
      view: {
        for: 'result',
        view: {
          card: 'diff',
          title: 'Edit src/feature.ts',
          diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }],
        },
      },
    })
    expect(removal.presentation).toMatchObject({
      phase: 'result',
      card: 'diff',
      diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }],
    })

    const cleared = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-cleared',
      name: 'write',
      view: {
        for: 'call',
        view: {
          card: 'diff',
          title: 'Write notes.md',
          diffs: [{ path: 'notes.md', oldText: null, newText: '' }],
          locations: [{ path: 'notes.md' }],
        },
      },
    })
    expect(cleared.presentation).toMatchObject({
      phase: 'call',
      card: 'diff',
      diffs: [{ path: 'notes.md', oldText: null, newText: '' }],
    })
  })

  it('keeps a written file and a terminal output longer than 4096 characters', () => {
    // The pinned `write` presents the whole `content` argument as the diff's
    // `newText`, and `bash` presents the executor's collected text body, whose
    // default in-memory cap is `maxOutputBytes = 64_000` per stream. Neither
    // value has a 4096-character host bound, so a clip here loses the tail of a
    // real diff or command output while the card still cites the host's own
    // totals and copies the clipped body as if it were complete.
    const file = 'const value = 1\n'.repeat(700)
    const output = 'stdout line\n'.repeat(5_300)
    expect(file.length).toBeGreaterThan(4_096)
    expect(output.length).toBeGreaterThan(4_096)

    const write = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-write',
      name: 'write',
      view: {
        for: 'call',
        view: {
          card: 'diff',
          title: 'Write notes.md',
          diffs: [{ path: 'notes.md', oldText: null, newText: file }],
        },
      },
    })
    const terminal = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-terminal-long',
      name: 'bash',
      view: {
        for: 'result',
        view: { card: 'terminal', title: 'pnpm test', output, exitCode: 0 },
      },
    })

    expect(write.presentation).toMatchObject({
      phase: 'call',
      card: 'diff',
      diffs: [{ path: 'notes.md', oldText: null, newText: file }],
    })
    expect(terminal.presentation).toMatchObject({
      phase: 'result',
      card: 'terminal',
      title: 'pnpm test',
      output,
      exitCode: 0,
    })
  })

  it('keeps a capped search result and a long call body whole', () => {
    // A capped `grep`/`glob` appends its recovery locator to the END of the
    // model-facing result text (`Full grep result stored at: …`), and the search
    // card carries only the retained page — so that footer is the one route to
    // the omitted rows. The row text is the block's own flattened content, which
    // the pinned client renders whole; a silent clip here cuts the locator off a
    // search the user can no longer complete.
    const body = 'src/feature.ts\nLine 1: const value = 1\n'.repeat(300)
    const footer =
      'Full grep result stored at: .dsh/spill/grep-results.txt. Read the file for the complete list.'
    const result = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-grep-capped',
      name: 'grep',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-grep-capped',
            content: [{ type: 'text', text: `${body}(${footer})` }],
            isError: false,
          },
        ],
        source: { kind: 'tool', callId: 'call-grep-capped' },
      },
      view: {
        for: 'result',
        view: {
          card: 'search',
          shape: 'matches',
          files: [{ path: 'src/feature.ts', matches: [{ lineNumber: 1, line: 'const value = 1' }] }],
          truncated: true,
          total: 900,
        },
      },
    })
    expect(result.outputSummary?.length).toBeGreaterThan(4_096)
    expect(result.outputSummary?.endsWith(`(${footer})`)).toBe(true)

    const command = `node -e "${'console.log(1)\\n'.repeat(400)}"`
    const call = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-bash-long',
      name: 'bash',
      arguments: JSON.stringify({ command }),
    })
    expect(command.length).toBeGreaterThan(4_096)
    expect(call.inputSummary).toBe(JSON.stringify({ command }))
  })

  it('converts the 1-based upstream file location line into the 0-based domain line', () => {
    // DSH documents `FileLocation.line` as "an optional 1-based line to focus"
    // and emits a `read`'s `offset` there, which defaults to 1. Everything this
    // side of the adapter — Domain, Webview protocol, VS Code positions —
    // addresses lines from zero, so line 1 must reach a caller as 0.
    const read = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-read-lines',
      name: 'read',
      view: {
        for: 'call',
        view: {
          card: 'generic',
          kind: 'read',
          locations: [
            { path: 'src/first.ts', line: 1 },
            { path: 'src/fifth.ts', line: 5 },
            { path: 'src/zero.ts', line: 0 },
            { path: 'src/fractional.ts', line: 2.5 },
          ],
        },
      },
    })

    const expected = [
      { path: 'src/first.ts', line: 0 },
      { path: 'src/fifth.ts', line: 4 },
      { path: 'src/zero.ts' },
      { path: 'src/fractional.ts' },
    ]
    expect(read.locations).toEqual(expected)
    expect(read.presentation).toMatchObject({ phase: 'call', card: 'generic', locations: expected })
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

/**
 * Hosts from 0.1.2-alpha.1 on send no session tool view: the card is derived
 * from the durable `tool/result` `meta` payload the tool's own
 * `presentationMeta` produced. A mapper that only reads the retired envelope
 * leaves every card and every mutation location off those rows.
 */
describe('DSH settled tool results carried as durable metadata', () => {
  it('derives the settled diff and its mutation location from the result metadata', () => {
    const diff = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-edit',
      message: { content: [{ type: 'text', text: 'Edited src/feature.ts' }] },
      meta: { diffs: [{ path: 'src/feature.ts', oldText: 'old', newText: 'new' }] },
    })

    expect(diff.presentation).toEqual({
      phase: 'result',
      card: 'diff',
      diffs: [{ path: 'src/feature.ts', oldText: 'old', newText: 'new' }],
    })
    expect(diff.category).toBe('diff')
    expect(diff.locations).toEqual([{ path: 'src/feature.ts' }])
  })

  it('derives read, grep, glob, and web cards from their persisted metadata', () => {
    const read = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-read',
      message: { content: [{ type: 'text', text: 'const answer = 42' }] },
      meta: {
        path: 'src/feature.ts',
        offset: 11,
        lines: [
          { number: 11, text: 'export const answer = 42' },
          { number: 12, text: '' },
        ],
        totalLines: 42,
        lang: 'ts',
      },
    })
    expect(read.presentation).toEqual({
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
    })

    const grep = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-grep',
      message: { content: [{ type: 'text', text: 'src/feature.ts:\n  4: answer' }] },
      meta: {
        shape: 'matches',
        files: [{ path: 'src/feature.ts', matches: [{ lineNumber: 4, line: 'answer' }] }],
        truncated: true,
        total: 3,
      },
    })
    expect(grep.presentation).toMatchObject({
      phase: 'result',
      card: 'search',
      shape: 'matches',
      files: [{ path: 'src/feature.ts', matches: [{ lineNumber: 4, line: 'answer' }] }],
      truncated: true,
      total: 3,
    })

    const glob = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-glob',
      message: { content: [{ type: 'text', text: 'src/a.ts\nsrc/b.ts' }] },
      meta: { shape: 'paths', paths: ['src/a.ts', 'src/b.ts'], truncated: false, total: 2 },
    })
    expect(glob.presentation).toMatchObject({
      phase: 'result',
      card: 'search',
      shape: 'paths',
      paths: ['src/a.ts', 'src/b.ts'],
      truncated: false,
      total: 2,
    })

    const search = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-web-search',
      message: { content: [{ type: 'text', text: 'Found 1 source' }] },
      meta: {
        sources: [
          {
            url: 'https://example.test/source',
            title: 'Source',
            snippet: 'Excerpt',
            publishedAt: '2026-01-02',
          },
        ],
        truncated: false,
        answer: 'A concise answer',
      },
    })
    expect(search.presentation).toMatchObject({
      phase: 'result',
      card: 'web',
      kind: 'search',
      sources: [
        {
          url: 'https://example.test/source',
          title: 'Source',
          snippet: 'Excerpt',
          publishedAt: '2026-01-02',
        },
      ],
      answer: 'A concise answer',
      truncated: false,
    })

    const fetch = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-web-fetch',
      message: { content: [{ type: 'text', text: 'Fetched https://example.test/page (HTTP 200)' }] },
      meta: { url: 'https://example.test/page', statusCode: 200, truncated: true },
    })
    expect(fetch.presentation).toMatchObject({
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      url: 'https://example.test/page',
      statusCode: 200,
      truncated: true,
    })
  })

  it('keeps a host view authoritative and ignores metadata that cannot become a card', () => {
    const viewed = mapped(rc6Mapper, 'tool/result', {
      callId: 'viewed',
      name: 'grep',
      view: {
        for: 'result',
        view: { card: 'search', shape: 'paths', paths: ['from-view.ts'], truncated: false, total: 1 },
      },
      meta: { shape: 'paths', paths: ['from-meta.ts'], truncated: false, total: 1 },
    })
    expect(viewed.presentation).toMatchObject({ phase: 'result', card: 'search', paths: ['from-view.ts'] })

    // A `write` that creates a file has no prior content: the host sends
    // `diffs: []` and leaves the whole-file diff to the client's arguments,
    // which a settled row no longer carries. That is an absent card, not an
    // empty diff claiming the file did not change.
    const created = mapped(rc6Mapper, 'tool/result', {
      callId: 'created',
      message: { content: [{ type: 'text', text: 'Created notes.md' }] },
      meta: { diffs: [] },
    })
    expect(created.presentation).toBeUndefined()
    expect(created.locations).toBeUndefined()

    // A settled failure never presents a card: the host projects metadata only
    // for a successful body, and an unapplied change must not read as applied.
    const failed = mapped(rc6Mapper, 'tool/result', {
      callId: 'failed',
      message: { content: [{ type: 'text', text: 'denied' }] },
      meta: { diffs: [{ path: 'src/feature.ts', oldText: 'old', newText: 'new' }] },
      isError: true,
    })
    expect(failed.presentation).toBeUndefined()

    for (const meta of [
      { diffs: [{ path: 7, oldText: null, newText: 'x' }] },
      { diffs: 'not-an-array' },
      { shape: 'matches', files: 'not-an-array', truncated: false, total: 0 },
      { shape: 'matches', truncated: false, total: 0 },
      { shape: 'paths', paths: 3, truncated: false, total: 0 },
      { shape: 'matches', files: [], truncated: 'yes', total: 0 },
      { sources: 'not-an-array', truncated: false },
      { url: 'https://example.test/page', statusCode: '200', truncated: false },
      { path: 'src/feature.ts', offset: 0, lines: [], totalLines: 3 },
      { path: 'src/feature.ts', offset: 11, lines: [{ number: 0, text: 'x' }], totalLines: 42 },
      { kind: 'search', truncated: false },
      'not-an-object',
      42,
      null,
      [1, 2],
    ]) {
      const malformed = mapped(rc6Mapper, 'tool/result', {
        callId: 'malformed',
        message: { content: [{ type: 'text', text: 'malformed metadata' }] },
        meta,
      })
      expect(malformed.presentation).toBeUndefined()
      expect(malformed.locations).toBeUndefined()
    }
  })

  it('derives an empty search page and an empty glob page without dropping the card', () => {
    // `grep`/`glob` with no hit still project their shape with an empty page and
    // `total: 0`; the card has to survive so the row can say so.
    const grep = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-grep-empty',
      message: { content: [{ type: 'text', text: 'No matches found' }] },
      meta: { shape: 'matches', files: [], truncated: false, total: 0 },
    })
    const glob = mapped(rc6Mapper, 'tool/result', {
      callId: 'meta-glob-empty',
      message: { content: [{ type: 'text', text: 'No files found' }] },
      meta: { shape: 'paths', paths: [], truncated: false, total: 0 },
    })
    expect(grep.presentation).toMatchObject({ card: 'search', shape: 'matches', files: [], total: 0 })
    expect(glob.presentation).toMatchObject({ card: 'search', shape: 'paths', paths: [], total: 0 })
  })
})

/**
 * The call side of the same transport split: a host without the view envelope
 * also stopped projecting the intended mutation through its tool definition, so
 * the running row of a first-party file mutation has to be derived from the
 * call's own arguments. Without it a running `write`/`edit` shows no diff at
 * all, and the extension-host change tracker loses the proposal it compares
 * against the settled observation.
 */
describe('DSH running tool calls carry their own intended mutation', () => {
  it('states the whole-file diff of a running write from its arguments', () => {
    const write = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-write',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'src/feature.ts', content: 'export const answer = 42' }),
    })

    expect(write.presentation).toEqual({
      phase: 'call',
      card: 'diff',
      title: 'write',
      diffs: [{ path: 'src/feature.ts', oldText: null, newText: 'export const answer = 42' }],
    })
    // The card's own diffs name the file for the row and for the change
    // tracker; the top-level location list stays what a host view or a settled
    // observation stated, so a running call never claims a confirmed location.
    expect(write.locations).toBeUndefined()
  })

  it('states the attempted replacement of a running edit, with a pure insertion for an empty needle', () => {
    const edit = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-edit',
      name: 'edit',
      arguments: JSON.stringify({
        file_path: 'src/feature.ts',
        old_string: 'const answer = 41',
        new_string: 'const answer = 42',
        replace_all: false,
      }),
    })
    expect(edit.presentation).toEqual({
      phase: 'call',
      card: 'diff',
      title: 'edit',
      diffs: [{ path: 'src/feature.ts', oldText: 'const answer = 41', newText: 'const answer = 42' }],
    })

    const insertion = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-edit-insert',
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/feature.ts', old_string: '', new_string: 'appended' }),
    })
    expect(insertion.presentation).toMatchObject({
      diffs: [{ path: 'src/feature.ts', oldText: null, newText: 'appended' }],
    })
  })

  it('states the create and the replacement of a running str_replace_editor call', () => {
    const created = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-create',
      name: 'str_replace_editor',
      arguments: JSON.stringify({ command: 'create', path: 'src/new.ts', file_text: 'export {}\n' }),
    })
    expect(created.presentation).toEqual({
      phase: 'call',
      card: 'diff',
      title: 'str_replace_editor',
      diffs: [{ path: 'src/new.ts', oldText: null, newText: 'export {}\n' }],
    })

    const replaced = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-replace',
      name: 'str_replace_editor',
      arguments: JSON.stringify({ command: 'str_replace', path: 'src/new.ts', old_str: 'a', new_str: 'b' }),
    })
    expect(replaced.presentation).toMatchObject({
      diffs: [{ path: 'src/new.ts', oldText: 'a', newText: 'b' }],
    })

    // The other editor commands mutate by line numbers or view the file; neither
    // states one replacement, so neither may claim a diff.
    for (const command of ['view', 'insert', 'undo_edit']) {
      const other = mapped(rc6Mapper, 'tool/call', {
        callId: `call-${command}`,
        name: 'str_replace_editor',
        arguments: JSON.stringify({ command, path: 'src/new.ts', file_text: 'text' }),
      })
      expect(other.presentation).toBeUndefined()
    }
  })

  it('keeps calls without a statable mutation on the generic row', () => {
    const cases: readonly Record<string, unknown>[] = [
      { name: 'custom_tool', arguments: JSON.stringify({ file_path: 'src/a.ts', content: 'x' }) },
      { name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts' }) },
      { name: 'write', arguments: 'not json' },
      { name: 'write', arguments: JSON.stringify('a string') },
      { name: 'write', arguments: JSON.stringify({ file_path: '   ', content: 'x' }) },
      { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.ts' }) },
      { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.ts', content: 42 }) },
      { name: 'edit', arguments: JSON.stringify({ file_path: 'src/a.ts', old_string: 'a' }) },
      { name: 'edit', arguments: JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 7 }) },
      {
        name: 'edit',
        arguments: JSON.stringify({
          file_path: 'src/a.ts',
          old_string: 'a',
          new_string: 'b',
          replace_all: 'yes',
        }),
      },
      { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'str_replace', file_text: 'x' }) },
      {
        name: 'str_replace_editor',
        arguments: JSON.stringify({ command: 'create', path: 'src/a.ts', file_text: 1 }),
      },
      { name: 'write', arguments: undefined },
    ]
    for (const data of cases) {
      const call = mapped(rc6Mapper, 'tool/call', { callId: 'generic', ...data })
      expect(call.presentation).toBeUndefined()
      expect(call.locations).toBeUndefined()
    }
  })

  it('refuses a mutation card for a malformed escalation pair and states the valid one', () => {
    const escalated = {
      file_path: 'src/a.ts',
      content: 'overwrite',
      sandbox_permissions: 'danger-full-access',
      justification: 'the file is outside the workspace',
    }
    const allowed = mapped(rc6Mapper, 'tool/call', {
      callId: 'escalated',
      name: 'write',
      arguments: JSON.stringify(escalated),
    })
    expect(allowed.presentation).toMatchObject({ card: 'diff' })

    for (const pair of [
      { sandbox_permissions: 'danger-full-access' },
      { sandbox_permissions: 'danger-full-access', justification: '   ' },
      { justification: 'because I said so' },
      { sandbox_permissions: 'read-only', justification: 'because I said so' },
    ]) {
      const refused = mapped(rc6Mapper, 'tool/call', {
        callId: 'refused',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'src/a.ts', content: 'overwrite', ...pair }),
      })
      expect(refused.presentation).toBeUndefined()
    }
  })

  it('derives no card for a code-dispatch subcall or a call the envelope already projected', () => {
    const args = JSON.stringify({ file_path: 'src/a.ts', content: 'x' })
    const parent = mapped(rc6Mapper, 'tool/call', {
      callId: 'ptc-parent',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return 1' }),
    })
    const subcall = mapped(rc6Mapper, 'tool/call', {
      callId: 'ptc-child',
      subCallId: 'ptc-child',
      parentCallId: 'ptc-parent',
      name: 'write',
      arguments: args,
    })
    expect(parent.presentation).toBeUndefined()
    expect(subcall.presentation).toBeUndefined()

    // A host that still sends the envelope stays authoritative: the card is the
    // host's own projection, not this client's reading of the arguments.
    const enveloped = mapped(rc6Mapper, 'tool/call', {
      callId: 'enveloped',
      name: 'write',
      arguments: args,
      view: {
        for: 'call',
        view: { card: 'generic', title: 'Write src/a.ts', rawInput: { path: 'src/a.ts' } },
      },
    })
    expect(enveloped.presentation).toEqual({
      phase: 'call',
      card: 'generic',
      title: 'Write src/a.ts',
      rawInput: '{"path":"src/a.ts"}',
    })
  })

  it('never selects the call-phase derivation for a settled row', () => {
    // A settled row with neither view nor metadata derives nothing from the
    // arguments: the timeline keeps the card the call already carried, so the
    // running intent is not re-declared as an applied observation.
    const settled = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-write',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'src/feature.ts', content: 'export const answer = 42' }),
      message: { content: [{ type: 'text', text: 'Wrote src/feature.ts' }] },
    })
    expect(settled.presentation).toBeUndefined()
    expect(settled.locations).toBeUndefined()
  })

  it('does not leak unrelated arguments through the derived card', () => {
    const call = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-write-secret',
      name: 'write',
      arguments: JSON.stringify({
        file_path: 'src/feature.ts',
        content: 'export const answer = 42',
        token: 'must-not-render',
        sandbox_permissions: 'workspace-write',
        justification: 'needed to write the file',
      }),
    })
    expect(call.presentation).toMatchObject({ card: 'diff' })
    expect(JSON.stringify(call.presentation)).not.toContain('must-not-render')
    expect(JSON.stringify(call.presentation)).toContain('export const answer = 42')
  })
})

describe('DSH running shell calls carry their own command', () => {
  it('states the command, description and working directory of a running bash call', () => {
    const bash = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-bash',
      name: 'bash',
      arguments: JSON.stringify({
        command: 'pnpm check',
        description: 'Run the repository checks',
        workdir: 'src',
        timeoutMs: 120000,
      }),
    })

    // The retired envelope carried the pinned host's own `presentCall` here. A
    // host without one leaves the command in the raw arguments only: the row
    // cannot say what it is running, and an approval paired with the call asks
    // the user to authorize text no surface can read.
    expect(bash.presentation).toEqual({
      phase: 'call',
      card: 'terminal',
      title: 'pnpm check',
      description: 'Run the repository checks',
      cwd: 'src',
    })
  })

  it('states a persistent shell call and a PowerShell call', () => {
    // The persistent provider omits `description` (its schema is command-only)
    // and still runs a command; the standard tools always send one.
    const persistent = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-persistent',
      name: 'bash',
      arguments: JSON.stringify({ command: 'pnpm test' }),
    })
    expect(persistent.presentation).toEqual({ phase: 'call', card: 'terminal', title: 'pnpm test' })

    const pwsh = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-pwsh',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'Get-ChildItem -Force', description: 'List the directory' }),
    })
    expect(pwsh.presentation).toMatchObject({ card: 'terminal', title: 'Get-ChildItem -Force' })
  })

  it('states the text a running terminal_send types into its session', () => {
    const send = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-send',
      name: 'terminal_send',
      arguments: JSON.stringify({ sessionId: 'term-7', text: 'pnpm dev\n' }),
    })
    expect(send.presentation).toEqual({
      phase: 'call',
      card: 'terminal',
      title: 'pnpm dev\n',
      description: 'Terminal term-7',
    })
  })

  it('keeps background and malformed shell calls on the generic row', () => {
    const cases: readonly Record<string, unknown>[] = [
      // A background call is acknowledged with a job id and no exit status; the
      // pinned host presented it as a generic row and the reference model draws
      // no terminal card for it either.
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm dev', run_in_background: true }) },
      { name: 'bash', arguments: JSON.stringify({ command: '   ', description: 'blank command' }) },
      { name: 'bash', arguments: JSON.stringify({ command: 42, description: 'wrong type' }) },
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', description: '' }) },
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', description: 5 }) },
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', timeoutMs: 0 }) },
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', timeoutMs: null }) },
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', workdir: 7 }) },
      { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', run_in_background: 'yes' }) },
      {
        name: 'bash',
        arguments: JSON.stringify({ command: 'pnpm test', sandbox_permissions: 'danger-full-access' }),
      },
      { name: 'terminal_send', arguments: JSON.stringify({ sessionId: '', text: 'pnpm dev' }) },
      { name: 'terminal_send', arguments: JSON.stringify({ sessionId: 'term-7', text: '' }) },
      { name: 'terminal_send', arguments: JSON.stringify({ sessionId: 'term-7', text: '  ' }) },
      {
        name: 'terminal_send',
        arguments: JSON.stringify({ sessionId: 'term-7', text: 'ls', submit: 'yes' }),
      },
      {
        name: 'terminal_send',
        arguments: JSON.stringify({ sessionId: 'term-7', text: 'ls', run_in_background: true }),
      },
      // A tool outside the first-party shell family states no shell this client
      // is allowed to run, whatever its arguments happen to carry.
      { name: 'custom_tool', arguments: JSON.stringify({ command: 'rm -rf /' }) },
      { name: 'read', arguments: JSON.stringify({ command: 'pnpm test' }) },
      { name: 'terminal_read', arguments: JSON.stringify({ sessionId: 'term-7', command: 'ls' }) },
      { name: 'bash', arguments: 'not json' },
      { name: 'bash', arguments: JSON.stringify(['pnpm test']) },
      { name: 'bash', arguments: undefined },
    ]
    for (const data of cases) {
      const call = mapped(rc6Mapper, 'tool/call', { callId: 'generic', ...data })
      expect(call.presentation).toBeUndefined()
    }
  })

  it('states a nested code-dispatch shell call and lets the envelope stay authoritative', () => {
    // The reference terminal model draws the running card for nested dispatch
    // calls (its diff model refuses them, so a mutation subcall stays flattened).
    const subcall = mapped(rc6Mapper, 'tool/call', {
      callId: 'ptc-child',
      subCallId: 'ptc-child',
      parentCallId: 'ptc-parent',
      name: 'bash',
      arguments: JSON.stringify({ command: 'pnpm test', description: 'Run the tests' }),
    })
    expect(subcall.presentation).toMatchObject({ card: 'terminal', title: 'pnpm test' })

    const enveloped = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-bash-envelope',
      name: 'bash',
      arguments: JSON.stringify({ command: 'pnpm check', description: 'Run the checks' }),
      view: { for: 'call', view: { card: 'generic', title: 'Run checks', kind: 'execute' } },
    })
    expect(enveloped.presentation).toEqual({
      phase: 'call',
      card: 'generic',
      title: 'Run checks',
      kind: 'execute',
    })
  })

  it('states no card for a durable shell result, and keeps the text the merge settles from', () => {
    // A real durable `tool/result` frame carries only its callId, message and
    // metadata — no name and no arguments, which belong to a different event —
    // so this mapper cannot pair a result with its call and states nothing
    // here. Deriving one from a name it guessed would present a running intent
    // as fresh evidence; the row's settled card is derived at the timeline
    // merge, where the call's own card and this text meet.
    const settled = mapped(rc6Mapper, 'tool/result', {
      callId: 'call-bash',
      message: { content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] },
    })
    expect(settled.presentation).toBeUndefined()
    expect(settled.outputSummary).toBe('ok\n[exit code: 0]')
  })

  it('does not leak unrelated shell arguments through the derived card', () => {
    const call = mapped(rc6Mapper, 'tool/call', {
      callId: 'call-bash-env',
      name: 'bash',
      arguments: JSON.stringify({
        command: 'curl 127.0.0.1/status',
        description: 'Probe the local endpoint',
        env: { API_TOKEN: 'must-not-render' },
      }),
    })
    expect(call.presentation).toMatchObject({ card: 'terminal' })
    expect(JSON.stringify(call.presentation)).not.toContain('must-not-render')
    expect(JSON.stringify(call.presentation)).toContain('curl 127.0.0.1/status')
  })
})

it('preserves submitted plan markdown from native and PTC argument objects only', () => {
  const plan = '# Delivery plan\n\n- Verify the change\n'
  expect(
    mapped(rc6Mapper, 'tool/call', {
      callId: 'plan',
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan }),
    }).submittedPlan,
  ).toEqual({ title: 'Delivery plan', markdown: plan })
  const event = rc6Mapper.event('tool/ptc-dispatch-start', {
    sessionId: 's1',
    data: { subCallId: 'plan', parentCallId: 'parent', name: 'exit_plan_mode', arguments: { plan } },
  })
  expect(event).toMatchObject({ type: 'tool.updated', tool: { submittedPlan: { markdown: plan } } })
  expect(
    mapped(rc6Mapper, 'tool/call', { callId: 'other', name: 'other', arguments: JSON.stringify({ plan }) })
      .submittedPlan,
  ).toBeUndefined()
  expect(
    mapped(rc6Mapper, 'tool/call', { callId: 'bad', name: 'exit_plan_mode', arguments: '{broken' })
      .submittedPlan,
  ).toBeUndefined()
})
