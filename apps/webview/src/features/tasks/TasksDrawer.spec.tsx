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

function renderDrawer(overrides: Partial<Parameters<typeof TasksDrawer>[0]> = {}): void {
  const props = {
    tasks: [task],
    loading: false,
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onOpen: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn().mockResolvedValue(undefined),
    onAnswer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  render(
    <I18nProvider>
      <TasksDrawer {...props} />
    </I18nProvider>,
  )
}

/** A real pointer click focuses the trigger before React sees the click. */
function openDrawer(name = '1 needs input'): HTMLElement {
  const trigger = screen.getByRole('button', { name })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

const runningTask: TaskSummary = {
  ...task,
  taskId: 'session:session-1',
  sourceId: 'session-1',
  kind: 'session',
  title: 'Refactor the parser',
  status: 'running',
  needsUserAction: false,
  actionKind: 'none',
  canAnswer: false,
  canSessionCancel: true,
}

describe('TasksDrawer failures', () => {
  afterEach(() => cleanup())

  it('reports a rejected stop instead of silently dropping it', async () => {
    const onStop = vi.fn().mockRejectedValue(new Error('task-state-stale'))
    renderDrawer({ tasks: [runningTask], onStop })
    openDrawer('1 active tasks')

    fireEvent.click(screen.getByRole('button', { name: 'Stop Refactor the parser' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('task-state-stale'))
    expect(screen.getByText('Refactor the parser')).toBeDefined()
  })

  it('keeps the answer draft and reports a rejected answer', async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error('task-not-owned'))
    renderDrawer({ onAnswer })
    openDrawer()

    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task answer' }), {
      target: { value: 'restart the worker' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('task-not-owned'))
    // The draft survives the refusal so the user can retry it verbatim.
    expect(screen.getByRole('textbox', { name: 'Task answer' })).toHaveProperty('value', 'restart the worker')
  })

  it('reports a rejected scope switch', async () => {
    const onScopeChange = vi.fn().mockRejectedValue(new Error('task-state-stale'))
    renderDrawer({ scope: 'current-session', onScopeChange })
    openDrawer()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('task-state-stale'))
  })

  it('clears the failure report once the same action succeeds', async () => {
    const onStop = vi.fn().mockRejectedValueOnce(new Error('task-state-stale')).mockResolvedValue(undefined)
    renderDrawer({ tasks: [runningTask], onStop })
    openDrawer('1 active tasks')

    fireEvent.click(screen.getByRole('button', { name: 'Stop Refactor the parser' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Stop Refactor the parser' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

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

  it('closes the task center on Escape and returns focus to the trigger', () => {
    renderDrawer()
    const trigger = openDrawer()
    expect(screen.getByRole('dialog', { name: 'Current-session tasks' })).toBeTruthy()

    fireEvent.keyDown(trigger, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Current-session tasks' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('lets Escape dismiss the inline answer form before the task center', () => {
    renderDrawer()
    const trigger = openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    const input = screen.getByRole('textbox', { name: 'Task answer' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Task answer' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Current-session tasks' })).toBeTruthy()

    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Current-session tasks' })).toBeNull()
  })

  it('leaves Escape to an inner layer that already consumed it', () => {
    renderDrawer()
    const trigger = openDrawer()
    trigger.addEventListener('keydown', (event) => event.preventDefault())

    fireEvent.keyDown(trigger, { key: 'Escape' })

    expect(screen.getByRole('dialog', { name: 'Current-session tasks' })).toBeTruthy()
  })

  it('does not resurface the answer form when the task center is reopened', () => {
    renderDrawer()
    const trigger = openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task answer' }), {
      target: { value: 'half-typed' },
    })

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Current-session tasks' })).toBeNull()

    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: 'Current-session tasks' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Task answer' })).toBeNull()
  })
})
