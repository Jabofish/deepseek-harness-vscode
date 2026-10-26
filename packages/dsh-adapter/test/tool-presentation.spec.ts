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
  it('keeps whole object arguments, generic presentations and result bodies before Host windowing', () => {
    const text = '  first line\n    indented line\n'.repeat(100)
    const entries = Array.from({ length: 100 }, (_, index) => ({ index, text }))
    const args = {
      command: 'run checks',
      input: entries,
      response: { body: text },
      deep: { a: { b: { c: { d: text } } } },
    }
    const call = mapped(rc6Mapper, 'tool/call', {
      callId: 'c',
      name: 'plugin-tool',
      arguments: args,
      view: { for: 'call', view: { card: 'generic', rawInput: args } },
    })
    expect(JSON.parse(call.inputSummary!)).toEqual(args)
    if (call.presentation?.card !== 'generic' || call.presentation.phase !== 'call')
      throw new Error('Missing generic presentation')
    expect(JSON.parse(call.presentation.rawInput!)).toEqual(args)
    const result = mapped(rc6Mapper, 'tool/result', {
      callId: 'c',
      name: 'plugin-tool',
      outputSummary: { response: { body: text }, rows: entries },
    })
    expect(JSON.parse(result.outputSummary!)).toEqual({ response: { body: text }, rows: entries })
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

it('keeps unidentified tool frames opaque rather than merging them under a fabricated id', () => {
  for (const name of ['tool/call', 'tool/result', 'tool/ptc-dispatch']) {
    expect(
      rc6Mapper.event(name, { sessionId: 's1', data: { name: 'shell', arguments: { command: 'pwd' } } }),
    ).toMatchObject({ type: 'unknown', name })
  }
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
