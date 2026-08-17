// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobView } from '@dsh-vscode/domain'
import { JobsDrawer } from './JobsDrawer.js'

function job(overrides: Partial<JobView> & Pick<JobView, 'id' | 'label' | 'status'>): JobView {
  return { kind: 'bash', startedAt: 0, ...overrides }
}

describe('JobsDrawer popover', () => {
  afterEach(() => cleanup())

  it('renders nothing until the session has at least one job', () => {
    const { container } = render(<JobsDrawer jobs={[]} />)
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
    render(<JobsDrawer jobs={jobs} />)
    const trigger = screen.getByRole('button', { name: '1 running' })
    fireEvent.click(trigger)
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('npm run dev')
    expect(rows[1]?.textContent).toContain('npm test')
    expect(rows[1]?.textContent).toContain('3s')
  })

  it('closes on Escape and returns focus to the trigger', () => {
    render(<JobsDrawer jobs={[job({ id: 'a', label: 'x', status: 'running' })]} />)
    const trigger = screen.getByRole('button', { name: '1 running' })
    fireEvent.click(trigger)
    expect(screen.getByRole('list', { name: 'Background jobs' })).toBeDefined()
    fireEvent.keyDown(trigger.parentElement as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: 'Background jobs' })).toBeNull()
  })
})
