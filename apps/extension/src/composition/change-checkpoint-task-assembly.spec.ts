import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import {
  createChangeCheckpointTaskAssembly,
  type ChangeCheckpointTaskDependencies,
} from './change-checkpoint-task-assembly.js'

vi.mock('vscode', () => ({ workspace: {} }))
afterEach(() => vi.useRealTimers())

it('posts task state changes immediately without a timer that can outlive the registry', () => {
  vi.useFakeTimers()
  let listener: ((event: BackendEvent) => void) | undefined
  const backend = {
    connection: { backendInstanceId: 'backend', connectionGeneration: 1 },
    events: {
      subscribe: (onEvent: (event: BackendEvent) => void) => {
        listener = onEvent
        return () => {
          listener = undefined
        }
      },
    },
  } as unknown as DshBackend
  const post = vi.fn(() => Promise.resolve(true))
  const assembly = createChangeCheckpointTaskAssembly({
    context: { globalStorageUri: { fsPath: path.resolve('fixture-storage') } },
    diagnostics: { log: vi.fn() },
    post,
    backendService: { requireBackend: () => backend },
    nextFeatureLocalSequence: () => 1,
    workspaceFolderIdForSession: () => 'workspace',
    currentWorkspaceFolders: () => [],
    currentWorkspaceFolderId: () => 'workspace',
  } as unknown as ChangeCheckpointTaskDependencies)
  assembly.taskFocus.setSessionId('s1')
  assembly.taskRegistry.attach(backend, () => 'workspace')
  listener?.({ type: 'session.status', sessionId: 's1', status: 'idle' })
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ name: 'tasks.invalidated', sessionId: 's1' }))
  expect(vi.getTimerCount()).toBe(0)
  assembly.taskRegistry.dispose()
  expect(listener).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
