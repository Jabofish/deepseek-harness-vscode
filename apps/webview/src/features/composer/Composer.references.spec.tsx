// @vitest-environment jsdom

import { useState, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReferenceCandidate } from '../../app/store.js'
import { Composer } from './Composer.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const candidate = (path: string): ReferenceCandidate => ({
  id: path,
  kind: 'file',
  path,
  label: path,
  description: '',
})

function Harness(props: {
  readonly references: readonly ReferenceCandidate[]
  readonly onReferenceQueryChange: (query: string | undefined, quoted: boolean) => void
  readonly onDraft: (draft: string) => void
  readonly onSubmit?: () => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  return (
    <Composer
      disabled={false}
      running={false}
      draft={draft}
      attachments={[]}
      onDraftChange={(next) => {
        setDraft((current) => {
          const value = typeof next === 'function' ? next(current) : next
          props.onDraft(value)
          return value
        })
      }}
      onPickAttachment={vi.fn()}
      onIngestFiles={vi.fn()}
      openFileCandidates={[]}
      openFilePickerOpen={false}
      openFilePickerLoading={false}
      attachedOpenFileIds={[]}
      onToggleOpenFilePicker={vi.fn()}
      onSelectOpenFile={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onSubmit={props.onSubmit ?? vi.fn()}
      onCancel={vi.fn()}
      onSteerQueue={vi.fn()}
      queue={[]}
      references={props.references}
      onReferenceQueryChange={props.onReferenceQueryChange}
    />
  )
}

it('does not pick a previous query candidate while the typed query waits for its debounce', () => {
  vi.useFakeTimers()
  const onReferenceQueryChange = vi.fn()
  const onSubmit = vi.fn()
  const drafts: string[] = []
  const view = render(
    <Harness
      references={[candidate('old.ts')]}
      onReferenceQueryChange={onReferenceQueryChange}
      onDraft={(draft) => drafts.push(draft)}
      onSubmit={onSubmit}
    />,
  )
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  fireEvent.change(prompt, { target: { value: '@src/b', selectionStart: 6, selectionEnd: 6 } })
  fireEvent.keyDown(prompt, { key: 'Enter' })
  expect(drafts.at(-1)).toBe('@src/b')
  expect(onSubmit).not.toHaveBeenCalled()
  act(() => {
    vi.advanceTimersByTime(200)
  })
  expect(onReferenceQueryChange).toHaveBeenLastCalledWith('src/b', false)

  view.rerender(
    <Harness
      references={[candidate('src/b.ts')]}
      onReferenceQueryChange={onReferenceQueryChange}
      onDraft={(draft) => drafts.push(draft)}
      onSubmit={onSubmit}
    />,
  )
  fireEvent.keyDown(prompt, { key: 'Enter' })
  expect(drafts.at(-1)).toBe('@src/b.ts')
  const calls = onReferenceQueryChange.mock.calls.length
  act(() => {
    vi.advanceTimersByTime(200)
  })
  expect(onReferenceQueryChange).toHaveBeenCalledTimes(calls)
})
