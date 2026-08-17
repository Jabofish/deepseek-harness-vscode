// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { Composer } from './Composer.js'

function baseProps(): Parameters<typeof Composer>[0] {
  return {
    disabled: false,
    running: false,
    draft: '',
    attachments: [],
    onDraftChange: vi.fn(),
    onPickAttachment: vi.fn(),
    onIngestFiles: vi.fn(),
    openFileCandidates: [{ id: 'dsh-open-file-current', name: 'LICENSE', active: true, supported: true }],
    openFilePickerOpen: false,
    openFilePickerLoading: false,
    attachedOpenFileIds: [],
    onToggleOpenFilePicker: vi.fn(),
    onSelectOpenFile: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onSteerQueue: vi.fn(),
    queue: [],
  }
}

function composerForm(): HTMLFormElement {
  return screen.getByRole('textbox', { name: 'Prompt' }).closest('form') as HTMLFormElement
}

describe('Composer', () => {
  afterEach(() => cleanup())

  it('starts compact and grows with long input until reaching its height cap', () => {
    render(<Composer {...baseProps()} />)
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    let scrollHeight = 42
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })

    fireEvent.change(textarea, { target: { value: 'Short prompt' } })
    expect(textarea.style.height).toBe('42px')
    expect(textarea.style.overflowY).toBe('hidden')

    scrollHeight = 104
    fireEvent.change(textarea, { target: { value: 'A prompt\nthat spans\nseveral lines' } })
    expect(textarea.style.height).toBe('104px')
    expect(textarea.style.overflowY).toBe('hidden')

    scrollHeight = 220
    fireEvent.change(textarea, { target: { value: 'A very long prompt' } })
    expect(textarea.style.height).toBe('132px')
    expect(textarea.style.overflowY).toBe('auto')
  })

  it('keeps attachment controls usable when names are long', () => {
    const name = 'diagnostics-from-a-narrow-vscode-window.txt'
    render(
      <Composer
        {...baseProps()}
        attachments={[{ uri: 'dsh-attachment:test-file', name, mimeType: 'text/plain' }]}
      />,
    )

    expect(screen.getByRole('button', { name: 'Attach file' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Choose an open file' })).toBeDefined()
    expect(screen.getByRole('button', { name: `Remove ${name}` })).toBeDefined()
    expect(screen.getByText(name).getAttribute('title')).toBe(name)
    expect(screen.getByRole('textbox', { name: 'Prompt' }).className).toContain('dsh-composer__textarea')
  })

  it('ingests pasted files instead of pasting their bytes into the draft', () => {
    const onIngestFiles = vi.fn()
    render(<Composer {...baseProps()} onIngestFiles={onIngestFiles} />)
    const file = new File(['png-bytes'], 'screenshot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByRole('textbox', { name: 'Prompt' }), {
      clipboardData: { files: [file] },
    })
    expect(onIngestFiles).toHaveBeenCalledTimes(1)
    expect(onIngestFiles).toHaveBeenCalledWith([file])
  })

  it('shows a drop overlay while files hover and ingests them on drop', () => {
    const onIngestFiles = vi.fn()
    render(<Composer {...baseProps()} onIngestFiles={onIngestFiles} />)
    const form = composerForm()
    const file = new File(['notes'], 'notes.md', { type: 'text/markdown' })
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } })
    expect(form.className).toContain('dsh-composer--dragging')
    expect(screen.getByText('Drop files to attach')).toBeDefined()
    fireEvent.drop(form, { dataTransfer: { files: [file], types: ['Files'] } })
    expect(form.className).not.toContain('dsh-composer--dragging')
    expect(onIngestFiles).toHaveBeenCalledWith([file])
  })

  it('ignores non-file drags', () => {
    const onIngestFiles = vi.fn()
    render(<Composer {...baseProps()} onIngestFiles={onIngestFiles} />)
    const form = composerForm()
    fireEvent.dragEnter(form, { dataTransfer: { types: ['text/plain'] } })
    expect(form.className).not.toContain('dsh-composer--dragging')
    fireEvent.drop(form, { dataTransfer: { types: ['text/plain'] } })
    expect(onIngestFiles).not.toHaveBeenCalled()
  })

  it('submits an idle draft as queue on plain Enter', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="hello" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('queue')
  })

  it('keeps Shift+Enter as the native newline before any submit path', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="hello" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
      key: 'Enter',
      shiftKey: true,
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('never sends while an IME composition is open', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="你好" onSubmit={onSubmit} />)
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
    // keyCode 229 is the legacy IME signal engines emit without isComposing.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('ignores held-down Enter repeats', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="hello" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter', repeat: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the textarea editable and queues on plain Enter while running', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<Composer {...baseProps()} draft="follow-up" running onSubmit={onSubmit} onCancel={onCancel} />)
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    expect(textarea.getAttribute('disabled')).toBeNull()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('queue')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('steers a running draft with the accelerated chord by default', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="follow-up" running onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
      key: 'Enter',
      ctrlKey: true,
    })
    expect(onSubmit).toHaveBeenCalledWith('steer')
  })

  // Split from the accelerated-chord case: the composer debounces repeated
  // sends within 250ms, so both chords must be exercised on fresh mounts.
  it('honors the busy-Enter preference for plain Enter while running', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="follow-up" running busyEnter="steer" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('steer')
  })

  it('uses the opposite of the busy-Enter preference for the accelerated chord', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps()} draft="follow-up" running busyEnter="steer" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
      key: 'Enter',
      metaKey: true,
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('queue')
  })

  it('steers every still-queued pending input on empty accelerated Enter while running', () => {
    const onSteerQueue = vi.fn()
    const onSubmit = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft=""
        running
        queue={[
          {
            id: 'q1',
            sessionId: 's1',
            text: 'first',
            attachments: [],
            mode: 'queue',
            createdAt: '2026-08-17T05:00:00.000Z',
          },
          {
            id: 'q2',
            sessionId: 's1',
            text: 'second',
            attachments: [],
            mode: 'steer',
            createdAt: '2026-08-17T05:00:01.000Z',
          },
        ]}
        onSteerQueue={onSteerQueue}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), {
      key: 'Enter',
      ctrlKey: true,
    })
    expect(onSteerQueue).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('opens a lightbox for image attachments and closes it on Escape', () => {
    const dataUri = 'data:image/png;base64,aXBob3Rv'
    render(
      <Composer
        {...baseProps()}
        attachments={[{ uri: 'dsh-attachment:photo-1234567890', name: 'shot.png', mimeType: 'image/png' }]}
        attachmentPreviews={{ 'dsh-attachment:photo-1234567890': dataUri }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png' }))
    const dialog = screen.getByRole('dialog', { name: 'Preview shot.png' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(dataUri)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Preview shot.png' })).toBeNull()
  })

  it('addresses previews by opaque handle when two attachments share a name', () => {
    render(
      <Composer
        {...baseProps()}
        attachments={[
          { uri: 'dsh-attachment:first-123456789', name: 'shot.png', mimeType: 'image/png' },
          { uri: 'dsh-attachment:second-12345678', name: 'shot.png', mimeType: 'image/png' },
        ]}
        attachmentPreviews={{
          'dsh-attachment:first-123456789': 'data:image/png;base64,Zmlyc3Q=',
          'dsh-attachment:second-12345678': 'data:image/png;base64,c2Vjb25k',
        }}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Preview shot.png' })[1]!)
    expect(
      screen.getByRole('dialog', { name: 'Preview shot.png' }).querySelector('img')?.getAttribute('src'),
    ).toBe('data:image/png;base64,c2Vjb25k')
  })

  it('keeps text attachments as plain rows without preview buttons', () => {
    render(
      <Composer
        {...baseProps()}
        attachments={[{ uri: 'dsh-attachment:notes-123456789', name: 'notes.txt', mimeType: 'text/plain' }]}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Preview notes.txt' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeDefined()
  })

  it('moves the command menu highlight with the arrow keys and wraps at both ends', () => {
    render(<Composer {...baseProps()} draft="/p" commands={commandFixtures()} onCommand={vi.fn()} />)
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    // Official combobox wiring: the textarea owns the menu and the highlight
    // rides aria-activedescendant instead of moving DOM focus.
    expect(textarea.getAttribute('aria-controls')).toBe('dsh-command-menu')
    expect(textarea.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe('dsh-command-option-0')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe('dsh-command-option-1')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe('dsh-command-option-0')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe('dsh-command-option-1')
  })

  it('ignores menu arrow arbitration while an IME composition is open', () => {
    render(<Composer {...baseProps()} draft="/p" commands={commandFixtures()} onCommand={vi.fn()} />)
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown', isComposing: true })
    expect(textarea.getAttribute('aria-activedescendant')).toBeNull()
  })

  it('dismisses the command menu on Escape until the query changes', () => {
    const view = render(
      <Composer {...baseProps()} draft="/p" commands={commandFixtures()} onCommand={vi.fn()} />,
    )
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeDefined()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull()
    expect(textarea.getAttribute('aria-expanded')).toBeNull()
    view.rerender(<Composer {...baseProps()} draft="/pl" commands={commandFixtures()} onCommand={vi.fn()} />)
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeDefined()
  })

  it('picks the highlighted menu row on Enter', () => {
    const onCommand = vi.fn()
    const onDraftChange = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft="/p"
        commands={commandFixtures()}
        onCommand={onCommand}
        onDraftChange={onDraftChange}
      />,
    )
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    // plan takes input, so the pick fills the draft instead of executing.
    expect(onCommand).not.toHaveBeenCalled()
    expect(onDraftChange).toHaveBeenCalledWith('/plan ')
  })

  it('executes a no-input command directly when its row is picked on Enter', () => {
    const onCommand = vi.fn()
    const onDraftChange = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft="/c"
        commands={commandFixtures()}
        onCommand={onCommand}
        onDraftChange={onDraftChange}
      />,
    )
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('/clear')
    expect(onDraftChange).toHaveBeenCalledWith('')
  })

  it('submits an args-tolerant command line through the command channel on Enter', () => {
    const onCommand = vi.fn()
    const onDraftChange = vi.fn()
    const onSubmit = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft="/goal fix the parser"
        commands={commandFixtures()}
        onCommand={onCommand}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    // Official enter transaction: the args-tolerant command claims the whole
    // line and executes it verbatim through commands/execute.
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('/goal fix the parser')
    expect(onDraftChange).toHaveBeenCalledWith('')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits a bare-token command without args through the command channel on Enter', () => {
    const onCommand = vi.fn()
    const onSubmit = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft="/clear"
        commands={commandFixtures()}
        onCommand={onCommand}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('/clear')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('lets a bare-token command carrying args fall through to the ordinary submit', () => {
    const onCommand = vi.fn()
    const onSubmit = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft="/clear everything"
        commands={commandFixtures()}
        onCommand={onCommand}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    // Official enter adjudication answers undefined here: no bare-token
    // command may claim free-form args, so Enter runs the default sink.
    expect(onCommand).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('queue')
  })

  it('completes the top command match on Tab', () => {
    const onDraftChange = vi.fn()
    render(
      <Composer {...baseProps()} draft="/go" commands={commandFixtures()} onDraftChange={onDraftChange} />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Tab' })
    expect(onDraftChange).toHaveBeenCalledWith('/goal ')
  })
})

function commandFixtures(): readonly DynamicCommand[] {
  return [
    { name: 'goal', description: 'Set the agent goal', input: { hint: '<goal>' } },
    { name: 'plan', description: 'Toggle planning mode', input: { hint: '[off]' } },
    { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
    { name: 'clear', description: 'Clear the timeline' },
  ]
}
