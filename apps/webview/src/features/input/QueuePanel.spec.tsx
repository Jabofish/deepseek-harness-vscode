// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueuedInput } from '@dsh-vscode/domain'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'

import { I18nProvider } from '../../i18n.js'
import { QueuePanel } from './QueuePanel.js'
import { Timeline } from '../chat/Timeline.js'

function handoffView(
  items: readonly QueuedInput[],
  nodes: TranscriptWindow['nodes'] = [],
  onRemove: (id: string) => void | Promise<void> = vi.fn(),
  connected = true,
  sessionId = 'session-1',
): React.ReactElement {
  const transcript: TranscriptWindow = {
    sessionId,
    revision: 1,
    nodes,
    eventFacts: [],
    lastSequence: 1,
    hasMore: false,
    historical: false,
    omittedNodeIds: [],
  }
  return (
    <I18nProvider>
      <Timeline sessionId={sessionId} nodes={nodes} streaming={false} />
      <QueuePanel
        key={sessionId}
        items={items}
        transcript={transcript}
        connected={connected}
        running={true}
        onEdit={vi.fn()}
        onRemove={onRemove}
        onModeChange={vi.fn()}
      />
    </I18nProvider>
  )
}

function queuedInput(id: string, text = id): QueuedInput {
  return {
    id,
    sessionId: 'session-1',
    text,
    attachments: [],
    textOnly: true,
    mode: 'queue',
    createdAt: '2026-08-31T00:00:00.000Z',
  }
}

function renderQueue(
  items: readonly QueuedInput[],
  running = false,
  onModeChange: (id: string, mode: QueuedInput['mode']) => void = vi.fn(),
  onEdit: (id: string, text: string) => void | Promise<void> = vi.fn(),
): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <QueuePanel
        items={items}
        running={running}
        onEdit={onEdit}
        onRemove={vi.fn()}
        onModeChange={onModeChange}
      />
    </I18nProvider>,
  )
}

describe('QueuePanel', () => {
  afterEach(() => cleanup())

  it('hides only the correlated direct send, preserving an identical queued message and its handoff', () => {
    const direct = { ...queuedInput('direct-message', 'same text'), rpcId: 'direct-request' }
    const queued = { ...queuedInput('queued-message', 'same text'), rpcId: 'other-request' }
    const props = {
      running: false,
      directRequestIds: ['direct-request'],
      transcript: {
        sessionId: 'session-1',
        revision: 1,
        nodes: [],
        eventFacts: [],
        lastSequence: 1,
        hasMore: false,
        historical: false,
        omittedNodeIds: [],
      },
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onModeChange: vi.fn(),
    }
    const view = render(
      <I18nProvider>
        <QueuePanel {...props} items={[direct]} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
    view.rerender(
      <I18nProvider>
        <QueuePanel {...props} items={[direct, queued]} />
      </I18nProvider>,
    )
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    view.rerender(
      <I18nProvider>
        <QueuePanel {...props} items={[]} />
      </I18nProvider>,
    )
    expect(screen.getAllByText('same text')).toHaveLength(1)
  })

  it('keeps removed queue text visible until the matching durable message renders, without duplication or resending', () => {
    const item = queuedInput('queued-message', 'First line\nSecond line')
    const remove = vi.fn()
    const view = render(handoffView([item], [], remove))
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(item.text)
    view.rerender(handoffView([], [], remove))
    expect(screen.getByText('Syncing with conversation…')).toBeTruthy()
    expect(screen.getByText('First line Second line')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /Mode for queued/u })).toBeNull()
    view.rerender(handoffView([], [{ kind: 'user-message', id: item.id, markdown: item.text }], remove))
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
    expect(screen.getAllByText('First line', { exact: false })).toHaveLength(1)
    view.rerender(handoffView([], [], remove))
    expect(screen.queryByText('Syncing with conversation…')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it('uses message IDs rather than matching repeated text, and handles transcript-first delivery', () => {
    const item = queuedInput('next-message', 'Repeated instruction')
    const older: TranscriptWindow['nodes'] = [
      { kind: 'user-message', id: 'previous-message', markdown: item.text },
    ]
    const view = render(handoffView([item], older))
    view.rerender(handoffView([], older))
    expect(screen.getByText('Syncing with conversation…')).toBeTruthy()
    view.rerender(handoffView([item], [...older, { kind: 'user-message', id: item.id, markdown: item.text }]))
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
    view.rerender(handoffView([], [...older, { kind: 'user-message', id: item.id, markdown: item.text }]))
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
  })

  it('does not retain explicitly removed messages, permits dismissing a receipt, and clears it on disconnect/session change', async () => {
    const item = queuedInput('pending', 'Awaiting its transcript')
    const remove = vi.fn().mockResolvedValue(undefined)
    const view = render(handoffView([item], [], remove))
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued prompt 1' }))
    await act(async () => {
      await Promise.resolve()
    })
    view.rerender(handoffView([], [], remove))
    expect(screen.queryByText('Syncing with conversation…')).toBeNull()
    view.rerender(handoffView([item], [], remove))
    view.rerender(handoffView([], [], remove))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss syncing prompt 1' }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Syncing with conversation…')).toBeNull()
    view.rerender(handoffView([item]))
    view.rerender(handoffView([]))
    expect(screen.getByText('Syncing with conversation…')).toBeTruthy()
    view.rerender(handoffView([], [], remove, false))
    expect(screen.queryByText('Syncing with conversation…')).toBeNull()
    view.rerender(handoffView([item]))
    view.rerender(handoffView([], [], remove, true, 'another-session'))
    expect(screen.queryByText('Syncing with conversation…')).toBeNull()
  })

  it('keeps a rejected removal eligible for normal transcript handoff', async () => {
    const item = queuedInput('pending', 'Keep after failed removal')
    const remove = vi.fn().mockRejectedValue(new Error('Removal failed'))
    const view = render(handoffView([item], [], remove))
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued prompt 1' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByDisplayValue(item.text)).toBeTruthy()
    view.rerender(handoffView([], [], remove))
    expect(screen.getByText(item.text)).toBeTruthy()
    expect(screen.getByText('Syncing with conversation…')).toBeTruthy()
  })

  it('preserves multiline edits, treats Enter as a new line, and commits the exact text on Ctrl+Enter', () => {
    const edit = vi.fn()
    renderQueue([queuedInput('multiline', 'Original\nmessage')], true, vi.fn(), edit)
    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'First line\nSecond line\nThird line' } })
    expect(fireEvent.keyDown(editor, { key: 'Enter' })).toBe(true)
    expect(edit).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    expect(edit).toHaveBeenCalledWith('multiline', 'First line\nSecond line\nThird line')
    fireEvent.blur(editor)
    expect(edit).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending prompt visible while the session is idle', () => {
    renderQueue([queuedInput('q1', 'first')])

    expect(screen.getByRole('region', { name: 'Queued prompts' })).toBeTruthy()
    expect(screen.getByDisplayValue('first')).toBeTruthy()
  })

  it('keeps the same queued text visible across running/idle transitions until its authoritative removal', () => {
    const renderPanel = (running: boolean, items: readonly QueuedInput[]): React.ReactElement => (
      <I18nProvider>
        <QueuePanel
          items={items}
          running={running}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          onModeChange={vi.fn()}
        />
      </I18nProvider>
    )
    const items = [queuedInput('q1', 'keep this instruction')]
    const view = render(renderPanel(true, items))
    const row = screen.getByDisplayValue('keep this instruction')
    view.rerender(renderPanel(false, items))
    expect(screen.getByDisplayValue('keep this instruction')).toBe(row)
    view.rerender(renderPanel(true, [...items, queuedInput('q2', 'next instruction')]))
    expect(screen.getByDisplayValue('keep this instruction')).toBe(row)
    expect(screen.getByDisplayValue('next instruction')).toBeTruthy()
    view.rerender(renderPanel(false, []))
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
  })

  it('renders one pending prompt as a compact row while the session is running', () => {
    renderQueue([queuedInput('q1', 'first')], true)

    expect(screen.getByRole('region', { name: 'Queued prompts' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Queued prompts/u })).toBeNull()
  })

  it('shows queued images and prevents an edit that the pinned host cannot preserve', () => {
    const item: QueuedInput = {
      ...queuedInput('q-image', 'describe this'),
      textOnly: false,
      images: [
        {
          attachmentId: 'image-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 2,
          height: 2,
        },
      ],
    }
    renderQueue([item], true)

    expect(screen.getByLabelText('Attached images')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt 1' }).hasAttribute('readonly')).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt 1' }).getAttribute('title')).toContain(
      'cannot be edited',
    )
  })

  it('shows queued files and keeps their row out of the text-only edit path', () => {
    renderQueue([{ ...queuedInput('q-file', 'read this'), textOnly: false, files: ['spec.md'] }], true)

    // A text-only replacement would drop the file, so the row reports what it
    // carries and refuses retyping instead of silently losing it.
    expect(screen.getByText('spec.md')).toBeTruthy()
    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    expect(editor.hasAttribute('readonly')).toBe(true)
    expect(editor.getAttribute('title')).toContain('cannot be edited')
  })

  it('sends the edited text of a text-only queued prompt', () => {
    const onEdit = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    expect(editor.hasAttribute('readonly')).toBe(false)
    fireEvent.change(editor, { target: { value: 'second' } })
    fireEvent.blur(editor)

    expect(onEdit).toHaveBeenCalledWith('q1', 'second')
  })

  it('refreshes an untouched editor when a newer queue projection changes the prompt', () => {
    const onEdit = vi.fn()
    const view = renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)
    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })

    view.rerender(
      <I18nProvider>
        <QueuePanel
          items={[queuedInput('q1', 'changed elsewhere')]}
          running
          onEdit={onEdit}
          onRemove={vi.fn()}
          onModeChange={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByDisplayValue('changed elsewhere')).toBe(editor)
    fireEvent.blur(editor)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('promotes a queued prompt to steer', () => {
    const onModeChange = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, onModeChange)

    fireEvent.click(screen.getByRole('button', { name: /Mode for queued prompt 1/u }))
    fireEvent.click(screen.getByRole('option', { name: 'Steer' }))

    expect(onModeChange).toHaveBeenCalledWith('q1', 'steer')
  })

  it('does not offer Steer when the session is idle', () => {
    renderQueue([queuedInput('q1', 'first'), queuedInput('q2', 'second')])

    const trigger = screen.getByRole('button', { name: /Mode for queued prompt 1/u })
    expect(trigger.hasAttribute('disabled')).toBe(true)
  })

  it('does not offer a delivery mode the Host cannot apply to a steering prompt', () => {
    const onModeChange = vi.fn()
    renderQueue([{ ...queuedInput('q-steer', 'first'), mode: 'steer' }], true, onModeChange)

    // The pinned Host only accepts `action: { kind: 'steer' }`; no request
    // moves a steering prompt back into the queue, so the mode is reported
    // instead of offered as a choice that silently does nothing.
    const trigger = screen.getByRole('button', { name: /Mode for queued prompt 1/u })
    expect(trigger.textContent).toContain('Steer')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('shows a multi-prompt backlog by default and collapses only on a user action', () => {
    renderQueue([queuedInput('q1', 'first'), queuedInput('q2', 'second')])

    const toggle = screen.getByRole('button', { name: /Queued prompts/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByDisplayValue('first')).toBeTruthy()
    expect(screen.getByDisplayValue('second')).toBeTruthy()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox', { name: 'Edit queued prompt 1' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt 1' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt 2' })).toBeTruthy()
  })
  it('commits an edited queued prompt on Ctrl+Enter and does not resend it on blur', () => {
    const onEdit = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: 'second' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith('q1', 'second')
    fireEvent.blur(editor)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('keeps an Enter that confirms an IME composition from committing the row', () => {
    const onEdit = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: '第二' } })
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })

    expect(onEdit).not.toHaveBeenCalled()
  })

  it('reverts an uncommitted edit on Escape and never sends it on blur', () => {
    const onEdit = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(screen.getByDisplayValue('first')).toBe(editor)
    fireEvent.blur(editor)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('restores the queued prompt when the Host rejects an edit and lets the user retry', async () => {
    let rejectEdit: ((reason: unknown) => void) | undefined
    const onEdit = vi.fn(
      (_id: string, _text: string) =>
        new Promise<void>((_resolve, reject) => {
          rejectEdit = reject
        }),
    )
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: 'second' } })
    fireEvent.blur(editor)
    expect(onEdit).toHaveBeenCalledWith('q1', 'second')

    // DSH kept the previous prompt: the row must not read as saved.
    await act(async () => {
      rejectEdit?.(new Error('edit rejected'))
      await Promise.resolve()
    })
    expect(screen.getByDisplayValue('first')).toBe(editor)
    fireEvent.blur(editor)
    expect(onEdit).toHaveBeenCalledTimes(1)

    // Retyping from the restored text reaches the Host again.
    fireEvent.change(editor, { target: { value: 'retry' } })
    fireEvent.blur(editor)
    expect(onEdit).toHaveBeenCalledTimes(2)
    expect(onEdit).toHaveBeenLastCalledWith('q1', 'retry')
  })

  it('keeps a newer draft when an earlier queue edit is rejected', async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined
    const onEdit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject
        }),
    )
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: 'submitted' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    fireEvent.change(editor, { target: { value: 'new draft' } })
    await act(async () => {
      rejectFirst?.(new Error('edit rejected'))
      await Promise.resolve()
    })

    expect(screen.getByDisplayValue('new draft')).toBe(editor)
    fireEvent.blur(editor)
    expect(onEdit).toHaveBeenCalledTimes(2)
    expect(onEdit).toHaveBeenLastCalledWith('q1', 'new draft')
  })

  it('ignores an older rejection after a later queue edit was submitted', async () => {
    const rejectEdits: Array<(reason: unknown) => void> = []
    const onEdit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectEdits.push(reject)
        }),
    )
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: 'first edit' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    fireEvent.change(editor, { target: { value: 'second edit' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    await act(async () => {
      rejectEdits[0]?.(new Error('older edit rejected'))
      await Promise.resolve()
    })

    expect(screen.getByDisplayValue('second edit')).toBe(editor)
    fireEvent.blur(editor)
    expect(onEdit).toHaveBeenCalledTimes(2)
  })
})
