import { AppError } from '@dsh-vscode/domain'
import type { AdvancedAgentUseCases, BackendService } from '@dsh-vscode/application'
import {
  JobFollowRegistry,
  relayJobFollowFrames,
  resolveJobFollowOffset,
} from '../backend/job-follow-registry.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import type { SessionScope } from './session-scope.js'

export interface JobFollowHostDependencies {
  readonly advancedUseCases: AdvancedAgentUseCases
  readonly backendService: BackendService
  readonly diagnostics: RedactedDiagnostics
  readonly requireCurrentWorkspaceSession: SessionScope['requireCurrentWorkspaceSession']
}

export interface JobFollowHost {
  readonly startJobFollow: (
    sessionId: string,
    jobId: string,
    followId: string,
    requestedFrom: number | undefined,
    signal: AbortSignal,
  ) => Promise<{ readonly started: boolean }>
  readonly stopJobFollow: (sessionId: string, jobId: string, followId: string) => boolean
  readonly stopAllJobFollows: () => void
}

/** Host-owned job output observers with authorized, workspace-scoped streams. */
export function createJobFollowHost(deps: JobFollowHostDependencies): JobFollowHost {
  const { advancedUseCases, backendService, diagnostics, requireCurrentWorkspaceSession } = deps
  const activeJobFollows = new JobFollowRegistry()
  const jobFollowKey = (sessionId: string, jobId: string): string => JSON.stringify([sessionId, jobId])
  const stopJobFollow = (sessionId: string, jobId: string, followId: string): boolean =>
    activeJobFollows.stop(jobFollowKey(sessionId, jobId), followId)
  const stopAllJobFollows = (): void => activeJobFollows.stopAll()
  const startJobFollow = async (
    sessionId: string,
    jobId: string,
    followId: string,
    requestedFrom: number | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly started: boolean }> => {
    const started = await activeJobFollows.start(
      jobFollowKey(sessionId, jobId),
      followId,
      signal,
      async (checkSignal) => {
        await requireCurrentWorkspaceSession(sessionId, checkSignal)
        const job = (await advancedUseCases.listJobs(sessionId, checkSignal)).find(
          (entry) => entry.id === jobId,
        )
        if (job === undefined)
          throw new AppError({
            code: 'DSH_NOT_FOUND',
            message: 'This job is no longer visible in the selected session.',
            retryable: false,
          })
        const from = resolveJobFollowOffset(job, requestedFrom)
        checkSignal.throwIfAborted()
        return { from, backend: backendService.requireBackend() }
      },
      async ({ from, backend }, followSignal) => {
        await relayJobFollowFrames({
          sessionId,
          jobId,
          followId,
          frames: advancedUseCases.followJob(sessionId, jobId, from, followSignal),
          signal: followSignal,
          publish: (event) => backend.events.publish?.(event),
          onFailure: (error) => {
            diagnostics.log('warn', 'job-follow-failed', {
              code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
            })
            backend.events.publish?.({
              type: 'notice',
              sessionId,
              level: 'warning',
              text: 'Job output could not be read. Start following again to retry.',
            })
          },
        })
      },
    )
    return { started }
  }
  return { startJobFollow, stopJobFollow, stopAllJobFollows }
}
