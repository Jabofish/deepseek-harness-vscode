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

describe('TasksDrawer failures', () => {
  afterEach(() => cleanup())

  it('locks an answer while pending, keeps failed drafts and ignores errors after dismissal', async () => {
    let reject!: (reason: Error) => void
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    renderDrawer({ onAnswer })
    const trigger = openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task answer' }), {
      target: { value: 'retry this answer' },
    })
    const form = document.querySelector('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Answer' }).disabled).toBe(true)
    reject(new Error('retryable failure'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('retryable failure'))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Task answer' }).value).toBe(
      'retry this answer',
    )
    fireEvent.submit(form)
    fireEvent.pointerDown(document.body)
    fireEvent.click(trigger)
    reject(new Error('late failure'))
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh tasks' }).disabled).toBe(false),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('TasksDrawer', () => {
  afterEach(() => cleanup())

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
})
