import { describe, expect, it } from 'vitest'

import {
  FeatureRequestLedger,
  buildTaskCenterHierarchy,
  buildTaskCenterSnapshot,
  recoverCheckpointRestore,
  simulateCheckpointRestore,
  type TaskCenterTask,
} from '../packages/domain/src/index.js'

const task = (
  overrides: Partial<{
    taskId: string
    sessionId: string
    parentTaskId: string
    ownerKind: 'extension' | 'external' | 'unknown'
    canSessionCancel: boolean
  }> = {},
): TaskCenterTask => ({
  taskId: overrides.taskId ?? 'task-1',
  sessionId: overrides.sessionId ?? 'session-1',
  ...(overrides.parentTaskId === undefined ? {} : { parentTaskId: overrides.parentTaskId }),
  workspaceFolderId: 'workspace-1',
  status: 'running' as const,
  ownerKind: overrides.ownerKind ?? 'external',
  taskRevision: 1,
  canSessionCancel: overrides.canSessionCancel ?? true,
})

describe('feature lifecycle spikes', () => {
  it('cancels only the matching owner and generation, and disposes pending work', () => {
    const ledger = new FeatureRequestLedger()
    const signal = ledger.register('request-1', 'view-1', 3)
    expect(signal?.aborted).toBe(false)
    expect(ledger.cancel('request-1', 'other-view', 3)).toBe(false)
    expect(ledger.state('request-1')).toBe('pending')
    expect(ledger.cancel('request-1', 'view-1', 2)).toBe(false)
    expect(ledger.cancel('request-1', 'view-1', 3)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(ledger.complete('request-1', 'view-1', 3)).toBe(false)

    const second = ledger.register('request-2', 'view-1', 4)
    expect(ledger.disposeOwned('view-1', 3)).toBe(1)
    expect(second?.aborted).toBe(false)
    expect(ledger.disposeOwned('view-1', 4)).toBe(1)
    expect(second?.aborted).toBe(true)
  })

  it('falls back to current-session task data until global evidence is complete', () => {
    const sessionTask = task({ taskId: 'session-task' })
    const otherTask = task({ taskId: 'other-task', sessionId: 'session-2' })
    const input = {
      currentSessionId: 'session-1',
      sessionTasks: [sessionTask, otherTask],
      globalTasks: [sessionTask, otherTask],
      evidence: { globalSeed: true, replay: true, parentChild: false, ownership: true },
    } as const
    const fallback = buildTaskCenterSnapshot(input)
    expect(fallback.source).toBe('current-session-fallback')
    expect(fallback.tasks.map((entry) => entry.taskId)).toEqual(['session-task'])
    expect(
      buildTaskCenterSnapshot({
        ...input,
        evidence: { globalSeed: true, replay: true, parentChild: true, ownership: true },
      }).source,
    ).toBe('global-seed')
  })

  it('preserves parent-child tasks in the hierarchy', () => {
    const parent = task({ taskId: 'parent' })
    const child = task({ taskId: 'child', parentTaskId: 'parent' })
    const orphan = task({ taskId: 'orphan', parentTaskId: 'missing' })
    const hierarchy = buildTaskCenterHierarchy([child, orphan, parent])
    expect(hierarchy).toHaveLength(2)
    expect(hierarchy[0]?.task.taskId).toBe('orphan')
    expect(hierarchy[1]?.task.taskId).toBe('parent')
    expect(hierarchy[1]?.children[0]?.task.taskId).toBe('child')
  })

  it('uses CAS before applying and rolls back a partial in-memory restore', () => {
    const current = new Map([
      ['src/a.ts', 'current-a'],
      ['src/b.ts', 'current-b'],
    ])
    const plan = [
      {
        relativePath: 'src/a.ts',
        expectedCurrentHash: 'current-a',
        checkpointContentHash: 'checkpoint-a',
        checkpointExists: true,
      },
      {
        relativePath: 'src/b.ts',
        expectedCurrentHash: 'current-b',
        checkpointContentHash: 'checkpoint-b',
        checkpointExists: true,
      },
    ] as const
    const conflict = simulateCheckpointRestore({
      operationId: 'restore-conflict',
      currentFiles: new Map([['src/a.ts', 'changed-after-capture']]),
      plan: [plan[0]],
    })
    expect(conflict.state).toBe('conflict')
    expect(conflict.files.get('src/a.ts')).toBe('changed-after-capture')

    const rolledBack = simulateCheckpointRestore({
      operationId: 'restore-failed',
      currentFiles: current,
      plan,
      failAfter: 1,
    })
    expect(rolledBack.state).toBe('rolled-back')
    expect(rolledBack.files).toEqual(current)
    expect(rolledBack.journal.rolledBackPaths).toEqual(['src/a.ts'])
  })

  it('reports partial restore and can recover an interrupted journal', () => {
    const current = new Map([
      ['src/a.ts', 'current-a'],
      ['src/b.ts', 'current-b'],
    ])
    const plan = [
      {
        relativePath: 'src/a.ts',
        expectedCurrentHash: 'current-a',
        checkpointContentHash: 'checkpoint-a',
        checkpointExists: true,
      },
      {
        relativePath: 'src/b.ts',
        expectedCurrentHash: 'current-b',
        checkpointContentHash: 'checkpoint-b',
        checkpointExists: true,
      },
    ] as const
    const partial = simulateCheckpointRestore({
      operationId: 'restore-partial',
      currentFiles: current,
      plan,
      failAfter: 1,
      rollbackFailureAt: 'src/a.ts',
    })
    expect(partial.state).toBe('partial-restore')
    expect(partial.files.get('src/a.ts')).toBe('checkpoint-a')

    const recovered = recoverCheckpointRestore({
      journal: { ...partial.journal, state: 'applying' },
      currentFiles: partial.files,
      backupFiles: current,
    })
    expect(recovered.state).toBe('rolled-back')
    expect(recovered.files).toEqual(current)
  })
})
