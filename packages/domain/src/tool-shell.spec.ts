import { describe, expect, it } from 'vitest'
import type { ToolPresentationView } from './tools.js'
import { parseShellExitStatus, settledToolPresentation, terminalPresentationFailed } from './tool-shell.js'

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

  it.each(['null', '999999999999999999999999999999'])(
    'keeps an unknown %s exit visible without inventing success',
    (code) => {
      const output = `stopped\n[exit code: ${code}]`
      expect(parseShellExitStatus(output)).toEqual({ output })
      expect(
        settledToolPresentation(callCard, {
          name: 'pwsh',
          rawArguments: shellArgs(),
          output,
          failed: false,
          settled: true,
        }),
      ).toBeUndefined()
    },
  )

  it('prefers a final signal marker over any exit marker', () => {
    expect(parseShellExitStatus('gone\n[killed by signal: SIGTERM]')).toEqual({
      output: 'gone',
      signal: 'SIGTERM',
    })
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

describe('settledToolPresentation', () => {
  it('marks a negative exit result as failed instead of success', () => {
    const view = settledToolPresentation(callCard, {
      name: 'pwsh',
      rawArguments: shellArgs(),
      output: 'crashed\n[exit code: -1073741510]',
      failed: false,
      settled: true,
    })
    expect(view).toMatchObject({ phase: 'result', card: 'terminal', exitCode: -1073741510 })
    expect(terminalPresentationFailed(view)).toBe(true)
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
})
