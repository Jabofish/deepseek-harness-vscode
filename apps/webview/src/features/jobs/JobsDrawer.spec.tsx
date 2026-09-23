// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('renders nothing until the session has at least one job', () => {
    const { container } = renderJobs([])
    expect(container.firstChild).toBeNull()
  })

  it('counts live jobs first and orders live rows before settled ones', () => {
    const jobs: readonly JobView[] = [
      job({
        id: 'bash-1',
        label: 'npm test',
        status: 'completed',
        kind: 'bash',
        startedAt: 1_000,
        finishedAt: 4_000,
      }),
      job({ id: 'bash-2', label: 'npm run dev', status: 'running', kind: 'bash', startedAt: 2_000 }),
    ]
    renderJobs(jobs)
    const trigger = screen.getByRole('button', { name: '1 running' })
    fireEvent.click(trigger)
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('npm run dev')
    expect(rows[1]?.textContent).toContain('npm test')
    expect(rows[1]?.textContent).toContain('3s')
  })

  it('closes on Escape and returns focus to the trigger', () => {
    renderJobs([job({ id: 'a', label: 'x', status: 'running' })])
    const trigger = screen.getByRole('button', { name: '1 running' })
    fireEvent.click(trigger)
    expect(screen.getByRole('list', { name: 'Background jobs' })).toBeDefined()
    fireEvent.keyDown(trigger.parentElement as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: 'Background jobs' })).toBeNull()
  })

  it('separates running and stopping counts in the session header', () => {
    renderJobs([
      job({ id: 'running', label: 'server', status: 'running' }),
      job({ id: 'stopping', label: 'old server', status: 'stopping' }),
    ])
    expect(screen.getByRole('button', { name: '1 running · 1 stopping' })).toBeDefined()
  })

  it('keeps alpha171 controller actions hidden from older adapters', () => {
    renderJobs([job({ id: 'old', label: 'legacy job', status: 'running' })])
    fireEvent.click(screen.getByRole('button', { name: '1 running' }))
    expect(screen.queryByRole('button', { name: 'Follow output' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop job' })).toBeNull()
  })

  it('shows follow and stop only when the exact adapter exposes Job Controller', () => {
    const onFollow = vi.fn().mockResolvedValue(undefined)
    const onKill = vi.fn().mockResolvedValue('requested')
    renderJobs([job({ id: 'alpha-job', label: 'server', status: 'running' })], {
      jobControllerAvailable: true,
      onFollow,
      onKill,
    })
    fireEvent.click(screen.getByRole('button', { name: '1 running' }))
    fireEvent.click(screen.getByRole('button', { name: 'Follow output' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop job' }))
    expect(onFollow).toHaveBeenCalledWith('alpha-job')
    expect(onKill).toHaveBeenCalledWith('alpha-job')
  })

  it.each([
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['killed', 'Killed'],
  ] as const)('shows a %s follow as settled while keeping its already-read output', (status, label) => {
    const terminalJob = job({
      id: 'alpha-job',
      label: 'server',
      status,
      startedAt: 1_000,
      finishedAt: 3_000,
    })
    renderJobs([job({ id: 'alpha-job', label: 'server', status: 'running', startedAt: 1_000 })], {
      jobControllerAvailable: true,
      following: {
        jobId: terminalJob.id,
        next: 12,
        chunks: [{ at: 0, text: 'finished output' }],
        lossy: false,
        job: terminalJob,
      },
    })

    expect(screen.getByRole('button', { name: '1' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '1' }))

    expect(screen.getByText(label)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Follow output' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Stop following' })).toBeNull()
    expect(screen.getByRole('log').textContent).toBe('finished output')
  })
})
