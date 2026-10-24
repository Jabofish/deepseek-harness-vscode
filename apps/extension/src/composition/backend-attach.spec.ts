import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendService } from '@dsh-vscode/application'
import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'

vi.mock('vscode', () => ({}))

import { createBackendAttach } from './backend-attach.js'
import { createSessionWatchController } from '../backend/session-watch-coordinator.js'

afterEach(() => vi.useRealTimers())

describe('backend attachment and session follow recovery', () => {
  it('keeps the watch listener through transport recovery so first-frame interactions are not lost', async () => {
    vi.useFakeTimers()
    const listeners = new Set<(event: BackendEvent) => void>()
    const watch = vi.fn()
    const unwatch = vi.fn()
    const backend = {
      events: {
        subscribe: (listener: (event: BackendEvent) => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        watchSession: watch,
        unwatchSession: unwatch,
      },
    } as unknown as DshBackend
    const emit = (event: BackendEvent): void => {
      for (const listener of [...listeners]) listener(event)
    }
    const sessionWatch = createSessionWatchController({
      delayMs: 100,
      readDirectory: () => Promise.resolve([]),
    })
    const backendService = new BackendService()
    const assembly = createBackendAttach({
      backendService,
      sessionWatch,
      changeTracker: { attach: () => {}, detach: () => {} },
      taskRegistry: { attach: () => {}, detach: () => {} },
      editorContextProvider: { dispose: () => {} },
      taskFocus: { clearSessionId: () => {} },
      currentWorkspaceFolderId: () => undefined,
      stopAllJobFollows: () => {},
      invalidateCurrentWorkspaceSessionDetails: () => {},
      diagnostics: { log: () => {} },
      eventLoopLag: { recentMaxLagMs: () => 0 },
      postBackendEvent: () => Promise.resolve(true),
    } as never)
    try {
      await assembly.attach(backend)
      emit({ type: 'connection.lost', reason: 'fixture disconnect' })
      emit({ type: 'connection.restored' })
      // Restored and the first actual frame are delivered in the same turn;
      // asynchronous account/projection reattachment has not completed yet.
      emit({
        type: 'question.requested',
        question: { id: 'q', sessionId: 's', prompt: 'Choose', allowFreeText: true },
      })
      await vi.advanceTimersByTimeAsync(300)
      expect(watch).toHaveBeenCalledExactlyOnceWith('s')
      expect(unwatch).not.toHaveBeenCalled()
      emit({ type: 'question.resolved', sessionId: 's', questionId: 'q' })
      await vi.advanceTimersByTimeAsync(100)
      expect(unwatch).toHaveBeenCalledExactlyOnceWith('s', { keepJobRows: false })
      assembly.detachSessionAdapters()
      emit({
        type: 'question.requested',
        question: { id: 'late', sessionId: 'other', prompt: 'Late', allowFreeText: true },
      })
      expect(watch).toHaveBeenCalledTimes(1)
    } finally {
      sessionWatch.dispose()
      await backendService.detach()
    }
  })
})
