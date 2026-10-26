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
        onDismissPending={vi.fn()}
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
        onDismissPending={vi.fn()}
      />
    </I18nProvider>,
  )
}

describe('QueuePanel', () => {
  afterEach(() => cleanup())

  it('keeps removed queue text visible until the matching durable message renders, without duplication or resending', () => {
    const item = queuedInput('queued-message', 'First line\nSecond line')
    const remove = vi.fn()
    const view = render(handoffView([item], [], remove))
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

  it('shows queued files and keeps their row out of the text-only edit path', () => {
    renderQueue([{ ...queuedInput('q-file', 'read this'), textOnly: false, files: ['spec.md'] }], true)

    // A text-only replacement would drop the file, so the row reports what it
    // carries and refuses retyping instead of silently losing it.
    expect(screen.getByText('spec.md')).toBeTruthy()
    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    expect(editor.hasAttribute('readonly')).toBe(true)
    expect(editor.getAttribute('title')).toContain('cannot be edited')
  })

  it('keeps an Enter that confirms an IME composition from committing the row', () => {
    const onEdit = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, vi.fn(), onEdit)

    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt 1' })
    fireEvent.change(editor, { target: { value: '第二' } })
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })

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
})
