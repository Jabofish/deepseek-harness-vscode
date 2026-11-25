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

  it('follows new output only while the reader stays at the end of the log', () => {
    const jobs = [job({ id: 'alpha-job', label: 'server', status: 'running', startedAt: 1_000 })]
    const following = (count: number): JobFollowState => ({
      jobId: 'alpha-job',
      followId: 'follow-1',
      next: count,
      chunks: Array.from({ length: count }, (_value, index) => ({ at: index, text: `line ${index}\n` })),
      lossy: false,
    })
    const view = renderJobs(jobs, { jobControllerAvailable: true, following: following(2) })
    fireEvent.click(screen.getByRole('button', { name: '1 running' }))
    const log = screen.getByRole('log')
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 })

    view.rerender(
      <JobsDrawer
        jobs={jobs}
        jobControllerAvailable
        following={following(3)}
        onFollow={() => Promise.resolve()}
        onStopFollowing={() => Promise.resolve()}
        onKill={() => Promise.resolve('requested')}
      />,
    )
    expect(log.scrollTop).toBe(1_000)

    // The reader scrolls up to an earlier line; new chunks leave it there.
    log.scrollTop = 200
    fireEvent.scroll(log)
    view.rerender(
      <JobsDrawer
        jobs={jobs}
        jobControllerAvailable
        following={following(4)}
        onFollow={() => Promise.resolve()}
        onStopFollowing={() => Promise.resolve()}
        onKill={() => Promise.resolve('requested')}
      />,
    )
    expect(log.scrollTop).toBe(200)
  })

  it('keeps following once a full buffer drops an old chunk for each new one', () => {
    const jobs = [job({ id: 'alpha-job', label: 'server', status: 'running', startedAt: 1_000 })]
    const window = (first: number): JobFollowState => ({
      jobId: 'alpha-job',
      followId: 'follow-1',
      next: first + 3,
      chunks: [0, 1, 2].map((offset) => ({ at: first + offset, text: `line ${first + offset}\n` })),
      lossy: true,
    })
    const drawer = (following: JobFollowState): React.ReactElement => (
      <JobsDrawer
        jobs={jobs}
        jobControllerAvailable
        following={following}
        onFollow={() => Promise.resolve()}
        onStopFollowing={() => Promise.resolve()}
        onKill={() => Promise.resolve('requested')}
      />
    )
    const view = renderJobs(jobs, { jobControllerAvailable: true, following: window(0) })
    fireEvent.click(screen.getByRole('button', { name: '1 running' }))
    const log = screen.getByRole('log')
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 })
    view.rerender(drawer(window(1)))
    expect(log.scrollTop).toBe(1_000)
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_200 })
    view.rerender(drawer(window(2)))
    expect(log.scrollTop).toBe(1_200)
  })
})
