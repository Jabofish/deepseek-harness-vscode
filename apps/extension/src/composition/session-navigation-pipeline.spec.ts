import { describe, expect, it, vi } from 'vitest'
import { BackendService } from '@dsh-vscode/application'
import type { DshBackend } from '@dsh-vscode/domain'
import { createSessionNavigation } from './session-navigation.js'
import { createHostEventPipeline, type HostEventPipelineDependencies } from './host-event-pipeline.js'

vi.mock('vscode', () => ({
  workspace: { isTrusted: true },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
}))

describe('native session navigation through the Host pipeline', () => {
  it('receives connection and directory facts while a Webview delivery is blocked', async () => {
    const backend = {
      connection: { capabilities: { dshVersion: '0.2.1-rc.2', features: new Set() } },
      events: { subscribe: () => () => undefined },
    } as unknown as DshBackend
    const backendService = new BackendService()
    const retitleEditorTab = vi.fn()
    const navigation = createSessionNavigation(
      {
        backendService,
        sessionUseCases: { list: () => Promise.resolve({ items: [] }) },
        currentWorkspaceFolders: () => [],
        listCurrentWorkspaces: () => Promise.resolve([]),
        listCurrentArchivedSessionIds: () => Promise.resolve([]),
        requireCurrentWorkspaceSession: vi.fn(),
        postEvent: () => Promise.resolve(true),
        postEventTo: () => Promise.resolve(true),
        retitleEditorTab,
      },
      { waitUntilReady: () => Promise.resolve(true) },
      () => Promise.resolve(undefined),
      () => Promise.resolve(undefined),
    )
    const changed = vi.fn()
    navigation.onDidChange(changed)
    let release!: (delivered: boolean) => void
    const post = vi
      .fn<HostEventPipelineDependencies['post']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      .mockResolvedValue(true)
    const deps: HostEventPipelineDependencies & { onEvent: (name: string, payload: unknown) => void } = {
      post,
      postTo: () => Promise.resolve(true),
      backendService,
      transcript: { accept: () => false, dispose: vi.fn() },
      diagnostics: { log: vi.fn() } as unknown as HostEventPipelineDependencies['diagnostics'],
      editorContextUseCases: {} as HostEventPipelineDependencies['editorContextUseCases'],
      featureOwner: vi.fn(),
      currentWorkspaceFolders: () => [],
      temporaryWorkspaceManager: {} as HostEventPipelineDependencies['temporaryWorkspaceManager'],
      runtimeUpdateProgress: { current: vi.fn() },
      onEvent: navigation.acceptEvent,
    }
    const pipeline = createHostEventPipeline(deps)
    const blocked = pipeline.postEvent('ui.notification', {})
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
    backendService.attach(backend, (event) => {
      void pipeline.postBackendEvent(backend, event)
    })
    pipeline.publishState({ kind: 'connected', backend: backend.connection })
    try {
      expect(changed).toHaveBeenCalledOnce()
      changed.mockClear()
      const directory = pipeline.postBackendEvent(backend, { type: 'session.added', sessionId: 's1' })
      expect(changed).toHaveBeenCalledOnce()
      const title = pipeline.postBackendEvent(backend, {
        type: 'session.projection',
        sessionId: 's1',
        key: 'title',
        value: 'Automatically named',
      })
      expect(retitleEditorTab).toHaveBeenCalledExactlyOnceWith('s1', 'Automatically named')
      expect(post).toHaveBeenCalledOnce()
      release(true)
      await Promise.all([blocked, directory, title])
    } finally {
      release(true)
      pipeline.dispose()
      await backendService.detach()
    }
  })
})
