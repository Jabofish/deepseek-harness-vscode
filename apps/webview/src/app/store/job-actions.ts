import type { JobView } from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { isJobView } from './event-values.js'
import { safeList } from './session-registry.js'
import type { AppActions, AppState, StateSetter } from './types.js'
import { object } from './unknown-record.js'

export interface JobActionHost {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
}

export interface JobActions {
  readonly methods: Pick<AppActions, 'followJob' | 'stopFollowingJob' | 'killJob'>
  /** Release the live follow before the panel opens another Session. */
  readonly stopBeforeSessionOpen: () => void
}

export function createJobActions(host: JobActionHost): JobActions {
  const readState = (): AppState => host.getState()
  const setState = host.setState
  let jobFollowGeneration = 0

  const stopBeforeSessionOpen = (): void => {
    const sessionId = readState().activeSessionId
    const following = readState().jobFollow
    if (sessionId === undefined || following === undefined) return
    jobFollowGeneration += 1
    setState((current) =>
      current.jobFollow?.generation === following.generation ? { ...current, jobFollow: undefined } : current,
    )
    void host.client
      .request<unknown>({
        type: 'job.follow.stop',
        requestId: requestId(),
        payload: { sessionId, jobId: following.jobId, followId: following.followId },
      })
      .catch(() => undefined)
  }

  const methods: JobActions['methods'] = {
    followJob: async (jobId) => {
      const sessionId = readState().activeSessionId
      const job = readState().jobs.find((entry) => entry.id === jobId)
      if (sessionId === undefined || job === undefined || !readState().jobControllerAvailable) return
      const prior = readState().jobFollow
      // A live or opening follow already owns this job/session. Reusing it is
      // idempotent; a second Host start could be rejected before it replaces
      // the first observer, leaving that original stream untracked in the UI.
      // A terminal status frame closes the observer and permits an explicit
      // replay from the last accepted byte offset.
      if (prior?.jobId === jobId && prior.error === undefined && prior.terminalStatusReceived !== true) return
      const generation = ++jobFollowGeneration
      if (prior !== undefined && prior.jobId !== jobId) {
        await host.client
          .request<unknown>({
            type: 'job.follow.stop',
            requestId: requestId(),
            payload: { sessionId, jobId: prior.jobId, followId: prior.followId },
          })
          .catch(() => undefined)
      }
      // Opening a different session or stopping while the prior stream was
      // being released invalidates this action before it can start a stale one.
      if (
        generation !== jobFollowGeneration ||
        readState().activeSessionId !== sessionId ||
        !readState().jobControllerAvailable
      )
        return
      const followId = requestId()
      const from = prior?.jobId === jobId ? prior.next : (job.output?.earliest ?? 0)
      setState((current) => {
        const existing = current.jobFollow?.jobId === jobId ? current.jobFollow : undefined
        return {
          ...current,
          jobFollow: {
            ...(existing ?? { jobId, next: from, chunks: [], lossy: false, job }),
            jobId,
            followId,
            next: Math.max(existing?.next ?? from, from),
            generation,
            awaitingOpenFrom: from,
            receivedOutputBytes: false,
            job: existing?.job ?? job,
            error: undefined,
          },
        }
      })
      try {
        await host.client.request<unknown>({
          type: 'job.follow.start',
          requestId: requestId(),
          payload: { sessionId, jobId, followId, from },
        })
      } catch (error) {
        void host.client
          .request<unknown>({
            type: 'job.follow.stop',
            requestId: requestId(),
            payload: { sessionId, jobId, followId },
          })
          .catch(() => undefined)
        setState((current) =>
          current.jobFollow?.generation === generation && current.jobFollow.followId === followId
            ? { ...current, jobFollow: undefined }
            : current,
        )
        throw error
      }
    },
    stopFollowingJob: async () => {
      const sessionId = readState().activeSessionId
      const following = readState().jobFollow
      jobFollowGeneration += 1
      setState((current) => ({ ...current, jobFollow: undefined }))
      if (sessionId === undefined || following === undefined) return
      await host.client.request<unknown>({
        type: 'job.follow.stop',
        requestId: requestId(),
        payload: { sessionId, jobId: following.jobId, followId: following.followId },
      })
    },
    killJob: async (jobId) => {
      const sessionId = readState().activeSessionId
      if (sessionId === undefined || !readState().jobControllerAvailable)
        throw new Error(translate('jobs.unavailable'))
      const result = object(
        await host.client.request<unknown>({
          type: 'job.kill',
          requestId: requestId(),
          payload: { sessionId, jobId },
        }),
      )
      if (result?.outcome !== 'requested' && result?.outcome !== 'already-finished')
        throw new Error(translate('jobs.killFailed'))
      const rows = await safeList<JobView>(
        host.client,
        { type: 'job.list', requestId: requestId(), payload: { sessionId } },
        isJobView,
      )
      if (rows !== undefined)
        setState((current) => (current.activeSessionId === sessionId ? { ...current, jobs: rows } : current))
      return result.outcome
    },
  }

  return { methods, stopBeforeSessionOpen }
}
