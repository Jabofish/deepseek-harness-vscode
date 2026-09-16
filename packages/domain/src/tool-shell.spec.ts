import { describe, expect, it } from 'vitest'
import type { ToolPresentationView } from './tools.js'
import {
  hasSpillNotice,
  parseShellExitStatus,
  settledToolPresentation,
  terminalPresentationFailed,
} from './tool-shell.js'

const callCard: Extract<ToolPresentationView, { readonly phase: 'call'; readonly card: 'terminal' }> = {
  phase: 'call',
  card: 'terminal',
  title: 'pnpm check',
  description: 'Run the checks',
}

const shellArgs = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ command: 'pnpm check', description: 'Run the checks', ...over })

describe('parseShellExitStatus', () => {
  it('removes a final exit marker and states its code', () => {
    expect(parseShellExitStatus('boom\n[exit code: 2]')).toEqual({ output: 'boom', exitCode: 2 })
  })

  it('prefers a final signal marker over any exit marker', () => {
    expect(parseShellExitStatus('gone\n[killed by signal: SIGTERM]')).toEqual({
      output: 'gone',
      signal: 'SIGTERM',
    })
  })

  it('states a clean exit for text with no marker, since the renderer only appends one for a failure', () => {
    expect(parseShellExitStatus('all good')).toEqual({ output: 'all good', exitCode: 0 })
  })

  it('only reads a marker at the very end', () => {
    expect(parseShellExitStatus('timed out\n[timed out after 1000ms]\n[exit code: 2]')).toEqual({
      output: 'timed out\n[timed out after 1000ms]',
      exitCode: 2,
    })
    // A marker without the preceding newline is output the command printed.
    expect(parseShellExitStatus('[exit code: 5]')).toEqual({ output: '[exit code: 5]', exitCode: 0 })
  })
})

describe('hasSpillNotice', () => {
  const notice = '(Omitted 50000 bytes. Full formatted result stored at: /spill/output.txt. Read the file.)'

  it('recognizes a notice-only result and a preview that carries one', () => {
    expect(hasSpillNotice(notice)).toBe(true)
    expect(hasSpillNotice(`partial output\n\n${notice}`)).toBe(true)
    expect(
      hasSpillNotice('(More bytes were omitted. Full formatted result stored at: a.txt. Read it.)'),
    ).toBe(true)
    expect(hasSpillNotice('(Omitted 0 bytes. Full formatted result stored at: a.txt. Read it.)')).toBe(true)
  })

  it('only recognizes a notice that ends the result', () => {
    expect(hasSpillNotice(`${notice}\nordinary output`)).toBe(false)
    expect(hasSpillNotice('ordinary output')).toBe(false)
    expect(hasSpillNotice('')).toBe(false)
    // The locator alone is not the convention: the guidance after it is part of it.
    expect(hasSpillNotice('(Omitted 50000 bytes. Full formatted result stored at: /spill/output.txt)')).toBe(
      false,
    )
  })
})

describe('settledToolPresentation', () => {
  it('settles a running shell card into the card its own result states', () => {
    expect(
      settledToolPresentation(callCard, {
        name: 'bash',
        rawArguments: shellArgs(),
        output: 'boom\n[exit code: 2]',
        failed: false,
        settled: true,
      }),
    ).toEqual({ phase: 'result', card: 'terminal', output: 'boom', exitCode: 2 })
  })

  it('never states a title, which a call card uses to name the command under approval', () => {
    const settled = settledToolPresentation(callCard, {
      name: 'bash',
      rawArguments: shellArgs(),
      output: 'ok\n[exit code: 0]',
      failed: false,
      settled: true,
    })
    expect(settled).toEqual({ phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 })
    expect(settled !== undefined && 'title' in settled).toBe(false)
  })

  it('states a signal for a killed command', () => {
    expect(
      settledToolPresentation(callCard, {
        name: 'pwsh',
        rawArguments: shellArgs(),
        output: 'gone\n[killed by signal: SIGKILL]',
        failed: false,
        settled: true,
      }),
    ).toEqual({ phase: 'result', card: 'terminal', output: 'gone', signal: 'SIGKILL' })
  })

  it('leaves a row that is still running, or already settled, untouched', () => {
    const running = {
      name: 'bash',
      rawArguments: shellArgs(),
      output: undefined,
      failed: false,
      settled: false,
    }
    expect(settledToolPresentation(callCard, running)).toBe(callCard)
    const resultCard: ToolPresentationView = { phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 }
    expect(
      settledToolPresentation(resultCard, {
        name: 'bash',
        rawArguments: shellArgs(),
        output: 'ok',
        failed: false,
        settled: true,
      }),
    ).toBe(resultCard)
    expect(
      settledToolPresentation(undefined, {
        name: 'bash',
        rawArguments: shellArgs(),
        output: 'ok',
        failed: false,
        settled: true,
      }),
    ).toBeUndefined()
  })

  it('keeps the call card when no result text arrived to state', () => {
    expect(
      settledToolPresentation(callCard, {
        name: 'bash',
        rawArguments: shellArgs(),
        output: undefined,
        failed: false,
        settled: true,
      }),
    ).toBe(callCard)
  })

  it('falls back to the generic row when the result has no text to state or cannot be trusted', () => {
    const settled = (
      over: Partial<Parameters<typeof settledToolPresentation>[1]> = {},
    ): ToolPresentationView | undefined =>
      settledToolPresentation(callCard, {
        name: 'bash',
        rawArguments: shellArgs(),
        output: 'boom',
        failed: false,
        settled: true,
        ...over,
      })
    // A persistent shell reports resets and partial output instead of one exit status.
    expect(settled({ rawArguments: JSON.stringify({ command: 'pwd' }) })).toBeUndefined()
    expect(settled({ name: 'pwsh', rawArguments: JSON.stringify({ command: 'pwd' }) })).toBeUndefined()
    // An errored result may be a failure message rather than rendered output.
    expect(settled({ failed: true })).toBeUndefined()
    // A retained preview's footer can hide the exit marker.
    expect(
      settled({
        output:
          'partial\n\n(Omitted 50000 bytes. Full formatted result stored at: /spill/o.txt. Read the file.)',
      }),
    ).toBeUndefined()
    // A background call is acknowledged with a job id and never an exit status.
    expect(settled({ rawArguments: shellArgs({ run_in_background: true }) })).toBeUndefined()
    // A result with no text at all states no status.
    expect(settled({ output: '' })).toBeUndefined()
  })

  it('states terminal_send output without inventing a process status', () => {
    const sendCard: ToolPresentationView = { phase: 'call', card: 'terminal', title: 'make' }
    expect(
      settledToolPresentation(sendCard, {
        name: 'terminal_send',
        rawArguments: JSON.stringify({ sessionId: 'pty-3', text: 'make' }),
        output: 'compiling',
        failed: false,
        settled: true,
      }),
    ).toEqual({ phase: 'result', card: 'terminal', output: 'compiling' })
    expect(
      settledToolPresentation(sendCard, {
        name: 'terminal_send',
        rawArguments: JSON.stringify({ sessionId: 'pty-3', text: 'make', run_in_background: true }),
        output: 'compiling',
        failed: false,
        settled: true,
      }),
    ).toBeUndefined()
  })

  it('keeps the call card when the arguments say nothing about a shell', () => {
    const facts = { name: 'bash', rawArguments: shellArgs(), output: 'ok', failed: false, settled: true }
    expect(settledToolPresentation(callCard, { ...facts, name: 'read' })).toBe(callCard)
    expect(settledToolPresentation(callCard, { ...facts, rawArguments: '{' })).toBe(callCard)
    expect(settledToolPresentation(callCard, { ...facts, rawArguments: undefined })).toBe(callCard)
  })

  it.each([
    ['timeout type', { timeoutMs: '1000' }],
    ['timeout value', { timeoutMs: 0 }],
    ['workdir type', { workdir: 7 }],
    ['background type', { run_in_background: 'yes' }],
    ['permission type', { sandbox_permissions: 7, justification: 'Need access' }],
    ['permission value', { sandbox_permissions: 'read-only', justification: 'Need access' }],
    ['missing justification', { sandbox_permissions: 'workspace-write' }],
    ['orphan justification', { justification: 'Need access' }],
    ['blank justification', { sandbox_permissions: 'workspace-write', justification: ' ' }],
    ['blank command', { command: ' ' }],
  ])('keeps malformed call arguments on the call card: %s', (_label, fields) => {
    expect(
      settledToolPresentation(callCard, {
        name: 'bash',
        rawArguments: shellArgs(fields),
        output: 'ok\n[exit code: 0]',
        failed: false,
        settled: true,
      }),
    ).toBe(callCard)
  })

  it('accepts valid optional and unknown fields on the open parameter root', () => {
    expect(
      settledToolPresentation(callCard, {
        name: 'bash',
        rawArguments: shellArgs({
          timeoutMs: 1_000,
          sandbox_permissions: 'workspace-write',
          justification: 'Write generated output',
          extension: { version: 1 },
        }),
        output: 'ok\n[exit code: 0]',
        failed: false,
        settled: true,
      }),
    ).toEqual({ phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 })
  })
})

describe('terminalPresentationFailed', () => {
  it('flags a failing exit and a signal, and nothing else', () => {
    expect(terminalPresentationFailed({ phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 })).toBe(
      false,
    )
    expect(
      terminalPresentationFailed({ phase: 'result', card: 'terminal', output: 'boom', exitCode: 2 }),
    ).toBe(true)
    expect(
      terminalPresentationFailed({ phase: 'result', card: 'terminal', output: 'gone', signal: 'SIGTERM' }),
    ).toBe(true)
    expect(terminalPresentationFailed({ phase: 'result', card: 'terminal', output: 'quiet' })).toBe(false)
    expect(terminalPresentationFailed({ phase: 'call', card: 'terminal', title: 'pnpm check' })).toBe(false)
    expect(terminalPresentationFailed({ phase: 'result', card: 'generic', content: ['boom'] })).toBe(false)
    expect(terminalPresentationFailed(undefined)).toBe(false)
  })
})
