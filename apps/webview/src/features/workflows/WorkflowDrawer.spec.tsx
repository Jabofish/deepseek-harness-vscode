// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowSummary } from '@dsh-vscode/domain'
import { WorkflowRunCard } from './WorkflowDrawer.js'

const RUN: WorkflowSummary = {
  id: 'run-1',
  sessionId: 'root',
  name: 'Release checks',
  status: 'running',
  stages: [
    {
      id: 'value:5:Build',
      phase: 'Build',
      members: [
        { seq: 1, label: 'Build web', childId: 'child-1', status: 'completed' },
        { seq: 2, label: 'Build ext', childId: 'child-2', status: 'running' },
      ],
    },
    {
      id: 'missing',
      phase: null,
      members: [{ seq: 3, label: 'Unit tests', childId: 'child-3', status: 'completed' }],
    },
  ],
}

describe('WorkflowRunCard', () => {
  afterEach(() => cleanup())

  it('forces unfinished runs and phases open, preserves an absent phase, and navigates members', () => {
    const onOpenChild = vi.fn()
    render(<WorkflowRunCard workflow={RUN} onOpenChild={onOpenChild} />)
    expect(
      screen.getByRole('button', { name: 'Release checks3 membersRunning' }).getAttribute('aria-expanded'),
    ).toBe('true')
    const buildPhase = screen.getByRole('button', { name: 'Build2 membersRunning 1' })
    expect(buildPhase.getAttribute('aria-expanded')).toBe('true')
    const unphased = screen.getByRole('button', { name: 'Unphased1 memberCompleted 1' })
    expect(unphased.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Open Build web' }))
    expect(onOpenChild).toHaveBeenCalledWith('child-1')
  })

  it('allows a clean completed run and phase to be disclosed manually', () => {
    render(
      <WorkflowRunCard
        workflow={{
          ...RUN,
          status: 'completed',
          stages: RUN.stages.map((stage) => ({
            ...stage,
            members: stage.members.map((member) => ({ ...member, status: 'completed' as const })),
          })),
        }}
      />,
    )
    const run = screen.getByRole('button', { name: 'Release checks3 membersCompleted' })
    expect(run.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(run)
    expect(screen.getByText('Build')).toBeDefined()
  })
})
