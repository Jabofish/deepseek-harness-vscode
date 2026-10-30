// @vitest-environment jsdom

import { useState, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration, DynamicCommand, PromptAttachment } from '@dsh-vscode/domain'

import { Composer } from './Composer.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

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

/** A controlled composer whose draft actually round-trips through the parent. */

describe('Composer', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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

  it.each(['classic', 'focused'] as const)(
    'returns focus to the prompt after Send in the %s layout without reclaiming it later',
    async (layout) => {
      let finish = (): void => undefined
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const onSubmit = vi.fn(() => pending)
      render(
        <ConversationLayoutProvider initialLayout={layout}>
          <Composer {...baseProps()} draft="First prompt" onSubmit={onSubmit} />
        </ConversationLayoutProvider>,
      )
      const prompt = screen.getByRole('textbox', { name: 'Prompt' })
      const send = screen.getByRole('button', { name: 'Send message' })
      send.focus()
      fireEvent.submit(send.closest('form')!)
      expect(onSubmit).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(prompt)
      const nextControl = screen.getByRole('button', { name: 'Cancel sending' })
      nextControl.focus()
      await act(async () => {
        finish()
        await pending
      })
      expect(document.activeElement).toBe(nextControl)
    },
  )

  it('keeps async submissions locked until settlement while leaving Stop available', async () => {
    let rejectFirstSubmission: (reason: Error) => void = () => undefined
    const firstSubmission = new Promise<void>((_resolve, reject) => {
      rejectFirstSubmission = reject
    })
    let attempts = 0
    const onSubmit = vi.fn((_mode: string, _signal?: AbortSignal) => {
      attempts += 1
      return attempts === 1 ? firstSubmission : Promise.resolve()
    })
    const onCancel = vi.fn()
    vi.useFakeTimers()
    const view = render(<Composer {...baseProps()} draft="hello" onSubmit={onSubmit} onCancel={onCancel} />)
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Cancel sending' }).hasAttribute('disabled')).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)

    view.rerender(<Composer {...baseProps()} draft="hello" running onSubmit={onSubmit} onCancel={onCancel} />)
    const stop = screen.getByRole('button', { name: 'Cancel sending' })
    expect(stop.hasAttribute('disabled')).toBe(false)
    expect(stop.getAttribute('aria-busy')).toBe('true')
    expect((textarea as HTMLTextAreaElement).value).toBe('hello')
    fireEvent.click(stop)
    expect(onSubmit.mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(onCancel).toHaveBeenCalledOnce()

    await act(async () => {
      rejectFirstSubmission(new Error('request failed'))
      await firstSubmission.catch(() => undefined)
    })
    view.rerender(<Composer {...baseProps()} draft="hello" onSubmit={onSubmit} onCancel={onCancel} />)
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false)

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(2)
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

  it('keeps Stop response independent of cancelling a pending queued send', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    const onSubmit = vi.fn((_mode: string, _signal?: AbortSignal) => pending)
    const onCancel = vi.fn()
    render(<Composer {...baseProps()} draft="follow-up" running onSubmit={onSubmit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' })
    const signal = onSubmit.mock.calls[0]?.[1]
    expect(screen.getByRole('button', { name: 'Cancel sending' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sending' }))
    expect(signal?.aborted).toBe(true)
    expect(onCancel).toHaveBeenCalledOnce()
    await act(async () => {
      resolve()
      await pending
    })
  })

  // Split from the accelerated-chord case so both chords are exercised on fresh mounts.

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

  it('keeps text typed while a submitted command line is still in flight', async () => {
    let admit: (() => void) | undefined
    const onCommand = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          admit = resolve
        }),
    )
    function Host(): ReactElement {
      const [draft, setDraft] = useState('/goal fix the parser')
      return (
        <Composer
          {...baseProps()}
          draft={draft}
          commands={commandFixtures()}
          onCommand={onCommand}
          onDraftChange={setDraft}
        />
      )
    }
    render(<Host />)
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onCommand).toHaveBeenCalledWith('/goal fix the parser', [], expect.any(AbortSignal))

    fireEvent.change(textarea, { target: { value: '/goal fix the parser and the lexer' } })
    await act(async () => {
      admit?.()
      await Promise.resolve()
    })

    expect(textarea.value).toBe('/goal fix the parser and the lexer')
  })

  it('takes the keyboard only for a request addressed to its own conversation', () => {
    const onFocusRequestHandled = vi.fn()
    const view = render(
      <Composer
        {...baseProps()}
        draft="kept draft"
        draftKey="session-a"
        onFocusRequestHandled={onFocusRequestHandled}
      />,
    )
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    expect(document.activeElement).not.toBe(textarea)

    view.rerender(
      <Composer
        {...baseProps()}
        draft="kept draft"
        draftKey="session-a"
        focusRequest={{ owner: 'session-b', token: 1 }}
        onFocusRequestHandled={onFocusRequestHandled}
      />,
    )
    expect(document.activeElement).not.toBe(textarea)
    expect(onFocusRequestHandled).not.toHaveBeenCalled()

    view.rerender(
      <Composer
        {...baseProps()}
        draft="kept draft"
        draftKey="session-a"
        focusRequest={{ owner: 'session-a', token: 2 }}
        onFocusRequestHandled={onFocusRequestHandled}
      />,
    )
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe('kept draft'.length)
    expect(onFocusRequestHandled).toHaveBeenCalledTimes(1)
  })

  it('never moves the keyboard into a read-only composer', () => {
    const onFocusRequestHandled = vi.fn()
    render(
      <Composer
        {...baseProps()}
        draft="read only"
        draftKey="session-a"
        inputDisabled
        focusRequest={{ owner: 'session-a', token: 1 }}
        onFocusRequestHandled={onFocusRequestHandled}
      />,
    )
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    expect(textarea.disabled).toBe(true)
    expect(document.activeElement).not.toBe(textarea)
    // The request is still consumed: a later remount must not claim the
    // keyboard for a navigation that already happened.
    expect(onFocusRequestHandled).toHaveBeenCalledTimes(1)
  })

  it('restores focus to the composer textarea when removing an attachment from the rail', () => {
    const onRemoveAttachment = vi.fn()
    const attachment: PromptAttachment = {
      uri: 'file:///path/to/image.png',
      name: 'image.png',
      mimeType: 'image/png',
    }
    render(<Composer {...baseProps()} attachments={[attachment]} onRemoveAttachment={onRemoveAttachment} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove image.png' })
    fireEvent.click(removeBtn)

    expect(onRemoveAttachment).toHaveBeenCalledWith('file:///path/to/image.png')
    const textarea = screen.getByRole('textbox', { name: 'Prompt' })
    expect(document.activeElement).toBe(textarea)
  })
})

describe('Composer model availability notice', () => {
  afterEach(() => cleanup())

  it('keeps the input usable and shows the host reason when the selected model is not routable', () => {
    const configuration: AgentConfiguration = {
      preset: 'standard',
      toolMode: 'native',
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: 'gateway', modelId: 'gateway-chat' },
    }
    render(
      <Composer
        {...baseProps()}
        draft="hello"
        configuration={configuration}
        models={[
          {
            id: 'served-chat',
            providerId: 'served',
            label: 'Served Chat',
            supportsReasoning: false,
          },
        ]}
        modelRoutable={false}
        onConfigurationChange={vi.fn()}
      />,
    )
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })

    expect(textarea.disabled).toBe(false)
    expect(textarea.getAttribute('placeholder')).toBe('Message…')
    const unavailableNotice = screen.getByText(
      'This model is not currently listed as available; DSH may ask you to sign in',
    )
    expect(unavailableNotice.getAttribute('role')).toBe('status')
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false)
    // Choosing a served model remains available, but is not required to send a prompt to DSH.
    expect(screen.getByRole('button', { name: /^Model and reasoning/u }).hasAttribute('disabled')).toBe(false)
  })

  it('accepts slash command suggestion via Tab key', () => {
    const onCommand = vi.fn()
    function Controlled(): ReactElement {
      const [draft, setDraft] = useState('/cl')
      return (
        <Composer
          {...baseProps()}
          draft={draft}
          commands={commandFixtures()}
          onCommand={onCommand}
          onDraftChange={setDraft}
        />
      )
    }
    render(<Controlled />)
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('/clear')
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('completes a visible suggestion when the command catalogue changes under the highlight', () => {
    const onCommand = vi.fn()
    function Controlled({ commands }: { readonly commands: readonly DynamicCommand[] }): ReactElement {
      const [draft, setDraft] = useState('/cl')
      return (
        <Composer
          {...baseProps()}
          draft={draft}
          commands={commands}
          onCommand={onCommand}
          onDraftChange={setDraft}
        />
      )
    }
    const clear = { name: 'clear', description: 'Clear conversation' }
    const view = render(
      <Controlled commands={[clear, { name: 'clone', description: 'Clone conversation' }]} />,
    )
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    view.rerender(<Controlled commands={[clear]} />)
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('/clear')
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('walks through sent prompts with ↑ and restores the empty draft with ↓', () => {
    render(<ControlledComposer promptHistory={['newest prompt', 'older prompt']} />)
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('newest prompt')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('older prompt')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('newest prompt')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('')
  })

  it('leaves ↑ to the caret once the composer holds text, and never during an IME composition', () => {
    render(<ControlledComposer promptHistory={['previous prompt']} />)
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })

    fireEvent.keyDown(textarea, { key: 'ArrowUp', isComposing: true })
    expect(textarea.value).toBe('')

    fireEvent.change(textarea, { target: { value: 'typed draft' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('typed draft')

    // An edited history entry is no longer an unedited walk position either.
    fireEvent.change(textarea, { target: { value: '' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('previous prompt')
    fireEvent.change(textarea, { target: { value: 'previous prompt edited' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('previous prompt edited')
  })
})

/** A composer whose draft round-trips through a parent, as the store does. */
function ControlledComposer(props: { readonly promptHistory: readonly string[] }): ReactElement {
  const [draft, setDraft] = useState('')
  return (
    <Composer {...baseProps()} draft={draft} onDraftChange={setDraft} promptHistory={props.promptHistory} />
  )
}

function commandFixtures(): readonly DynamicCommand[] {
  return [
    { name: 'goal', description: 'Set the agent goal', input: { hint: '<goal>' } },
    { name: 'plan', description: 'Toggle planning mode', input: { hint: '[off]' } },
    { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
    { name: 'clear', description: 'Clear the timeline' },
  ]
}
