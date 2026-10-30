import { EventEmitter } from 'node:events'
import { execFile, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateOwnedWindowsTree } from './owned-process-tree.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const rows = (entries: readonly (readonly [number, number])[]): string =>
  JSON.stringify(entries.map(([ProcessId, ParentProcessId]) => ({ ProcessId, ParentProcessId })))

describe('owned Windows shutdown racing descendant exit', () => {
  const before = rows([
    [100, 1],
    [101, 100],
    [102, 101],
    [900, 1],
  ])

  it.each([
    ['the tree is gone', rows([[900, 1]]), true],
    [
      'a grandchild survives its parent',
      rows([
        [102, 101],
        [900, 1],
      ]),
      false,
    ],
    [
      'a new direct child survives',
      rows([
        [103, 100],
        [900, 1],
      ]),
      false,
    ],
    [
      'the root identifier is still present',
      rows([
        [100, 1],
        [900, 1],
      ]),
      false,
    ],
    ['the diagnostic is malformed', '{broken', false],
    ['the diagnostic is empty', '[]', false],
  ] as const)('accepts taskkill failure only with confirmed closure: %s', async (_name, after, success) => {
    const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null })
    const failure = new Error('taskkill raced an exiting descendant')
    let reads = 0
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const executable = args[0] as string
      const callback = args[3] as (error: Error | null, stdout: string) => void
      if (executable.endsWith('powershell.exe')) callback(null, reads++ === 0 ? before : after)
      else {
        // The callback may arrive before the held child's close event.
        callback(failure, '')
        queueMicrotask(() => child.emit('close'))
      }
      return undefined as unknown as ChildProcess
    })
    const stop = terminateOwnedWindowsTree(child as unknown as ChildProcess)
    if (success) await expect(stop).resolves.toBeUndefined()
    else await expect(stop).rejects.toMatchObject({ code: 'PROCESS_FAILED', retryable: true })
    expect(child.listenerCount('close')).toBe(0)
  })

  it('retains the original failure when process enumeration is unavailable', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null })
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string) => void
      callback(new Error('system tool unavailable'), '')
      if (String(args[0]).endsWith('taskkill.exe')) queueMicrotask(() => child.emit('close'))
      return undefined as unknown as ChildProcess
    })
    await expect(terminateOwnedWindowsTree(child as unknown as ChildProcess)).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: true,
    })
    expect(child.listenerCount('close')).toBe(0)
  })
})
