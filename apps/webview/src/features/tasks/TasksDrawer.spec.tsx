// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskSummary } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { TasksDrawer } from './TasksDrawer.js'

const task: TaskSummary = {
  taskId: 'interaction:question:q1',
  sourceId: 'q1',
  sessionId: 'session-1',
  parentTaskId: 'session:session-1',
  workspaceFolderId: 'workspace-1',
  kind: 'interaction',
  title: 'Choose a plan',
  status: 'needs-input',
  needsUserAction: true,
  actionKind: 'question',
  interactionId: 'q1',
  startedAt: 0,
  updatedAt: 1,
  childCount: 0,
  canOpen: true,
  canAnswer: true,
  canSessionCancel: false,
  canProcessStop: false,
  ownerKind: 'unknown',
  taskRevision: 1,
}

describe('TasksDrawer', () => {
  afterEach(() => cleanup())

  it('renders nothing for an empty settled task list', () => {
    render(
      <I18nProvider>
        <TasksDrawer
          tasks={[]}
          loading={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn().mockResolvedValue(undefined)}
          onStop={vi.fn().mockResolvedValue(undefined)}
          onAnswer={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>,
    )
    expect(screen.queryByRole('button', { name: '1 needs input' })).toBeNull()
  })

  it('answers an actionable task through the explicit inline form', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined)
    render(
      <I18nProvider>
        <TasksDrawer
          tasks={[task]}
          loading={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn().mockResolvedValue(undefined)}
          onStop={vi.fn().mockResolvedValue(undefined)}
          onAnswer={onAnswer}
        />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '1 needs input' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task answer' }), {
      target: { value: 'yes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(task, 'yes'))
  })

  it('labels workspace scope and reports incomplete session reads', () => {
    render(
      <I18nProvider>
        <TasksDrawer
          tasks={[{ ...task, sessionTitle: 'Background session' }]}
          loading={false}
          scope="workspace"
          complete={false}
          omittedSessions={1}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onScopeChange={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn().mockResolvedValue(undefined)}
          onStop={vi.fn().mockResolvedValue(undefined)}
          onAnswer={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '1 needs input' }))

    expect(screen.getByRole('dialog', { name: 'Workspace tasks' })).toBeTruthy()
    expect(screen.getByText('1 workspace sessions could not be read.')).toBeTruthy()
    expect(screen.getByText('Background session')).toBeTruthy()
  })
})
