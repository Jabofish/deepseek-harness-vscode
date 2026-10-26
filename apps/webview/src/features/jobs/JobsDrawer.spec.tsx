// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobView } from '@dsh-vscode/domain'
import type { JobFollowState } from '../../app/store.js'
import { JobsDrawer } from './JobsDrawer.js'

function job(overrides: Partial<JobView> & Pick<JobView, 'id' | 'label' | 'status'>): JobView {
  return { kind: 'bash', startedAt: 0, ...overrides }
}

function renderJobs(
  jobs: readonly JobView[],
  options: Partial<{
    jobControllerAvailable: boolean
    following: JobFollowState | undefined
    onFollow: (jobId: string) => Promise<void>
    onStopFollowing: () => Promise<void>
    onKill: (jobId: string) => Promise<'requested' | 'already-finished'>
  }> = {},
): ReturnType<typeof render> {
  return render(
    <JobsDrawer
      jobs={jobs}
      jobControllerAvailable={options.jobControllerAvailable ?? false}
      following={options.following}
      onFollow={options.onFollow ?? (() => Promise.resolve())}
      onStopFollowing={options.onStopFollowing ?? (() => Promise.resolve())}
      onKill={options.onKill ?? (() => Promise.resolve('requested'))}
    />,
  )
}

describe('JobsDrawer popover', () => {
  afterEach(() => cleanup())

  it('locks job controls during a pending action and exposes retry inside the list', async () => {
    let reject!: (reason: Error) => void
    const onKill = vi.fn(
      () =>
        new Promise<'requested'>((_resolve, fail) => {
          reject = fail
        }),
    )
    renderJobs([job({ id: 'job-1', label: 'build', status: 'running' })], {
      jobControllerAvailable: true,
      onKill,
    })
    fireEvent.click(screen.getByRole('button', { name: '1 running' }))
    const kill = screen.getByRole('button', { name: 'Stop job' })
    fireEvent.click(kill)
    fireEvent.click(kill)
    expect(onKill).toHaveBeenCalledTimes(1)
    expect(onKill).toHaveBeenCalledWith('job-1')
    reject(new Error('temporary failure'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    expect((kill as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a failed output stream as retryable while retaining captured output', () => {
    const onFollow = vi.fn().mockResolvedValue(undefined)
    renderJobs([job({ id: 'alpha-job', label: 'server', status: 'running', startedAt: 1_000 })], {
      jobControllerAvailable: true,
      onFollow,
      following: {
        jobId: 'alpha-job',
        followId: 'follow-1',
        next: 12,
        chunks: [{ at: 0, text: 'partial output' }],
        lossy: false,
        error: 'stream-failed',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: '1 running' }))

    expect(screen.getByRole('button', { name: 'Follow output' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Stop following' })).toBeNull()
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByRole('log').textContent).toBe('partial output')
    fireEvent.click(screen.getByRole('button', { name: 'Follow output' }))
    expect(onFollow).toHaveBeenCalledWith('alpha-job')
  })
})
