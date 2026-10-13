import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, DshBackend, JobFollowFrame, SessionDetail } from '@dsh-vscode/domain'
import { AdvancedAgentUseCases, BackendService } from '@dsh-vscode/application'
import { relayJobFollowFrames } from '../backend/job-follow-registry.js'
import { createJobFollowHost } from './job-follow-host.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'

describe('job follow lifecycle regressions', () => {
  it('drops a frame arriving after cancellation and closes its iterator', async () => {
    const controller = new AbortController()
    const publish = vi.fn<(event: BackendEvent) => void>()
    const closed = vi.fn()
    const frames = {
      async *[Symbol.asyncIterator]() {
        try {
          await Promise.resolve()
          controller.abort()
          yield { type: 'output', chunks: [], next: 1 } satisfies JobFollowFrame
        } finally {
          closed()
        }
      },
    }
    await relayJobFollowFrames({
      sessionId: 's',
      jobId: 'j',
      followId: 'f',
      frames,
      signal: controller.signal,
      publish,
      onFailure: vi.fn(),
    })
    expect(publish).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('rejects a connection replacement while the job roster is being authorized', async () => {
    const service = new BackendService()
    const follow = vi.fn()
    const replacement = {
      events: { subscribe: () => () => undefined },
      jobs: { follow },
    } as unknown as DshBackend
    const original = {
      events: { subscribe: () => () => undefined },
      jobs: {
        list: () => {
          service.attach(replacement, () => undefined)
          return Promise.resolve([{ id: 'j' }])
        },
        follow,
      },
    } as unknown as DshBackend
    service.attach(original, () => undefined)
    const host = createJobFollowHost({
      backendService: service,
      advancedUseCases: new AdvancedAgentUseCases(service),
      requireCurrentWorkspaceSession: vi.fn((): Promise<SessionDetail> =>
        Promise.resolve({
          id: 's',
          workspaceId: 'w',
          title: 'Session',
          blank: false,
          status: 'idle',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'default',
            planMode: false,
            model: { providerId: 'p', modelId: 'm' },
          },
        }),
      ),
      diagnostics: { log: vi.fn() } as unknown as RedactedDiagnostics,
    })
    await expect(host.startJobFollow('s', 'j', 'f', 0, new AbortController().signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(follow).not.toHaveBeenCalled()
  })
})
