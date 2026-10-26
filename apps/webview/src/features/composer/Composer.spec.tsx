// @vitest-environment jsdom

import { useState, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration, DynamicCommand } from '@dsh-vscode/domain'

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
})

function commandFixtures(): readonly DynamicCommand[] {
  return [
    { name: 'goal', description: 'Set the agent goal', input: { hint: '<goal>' } },
    { name: 'plan', description: 'Toggle planning mode', input: { hint: '[off]' } },
    { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
    { name: 'clear', description: 'Clear the timeline' },
  ]
}
