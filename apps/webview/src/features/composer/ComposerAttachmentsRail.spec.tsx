// @vitest-environment jsdom

import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComposerAttachmentsRail } from './ComposerAttachmentsRail.js'

afterEach(cleanup)

it('offers Open only for attachments that have a text view', () => {
  render(
    <ComposerAttachmentsRail
      attachments={[
        { uri: 'a1', name: 'notes.md', mimeType: 'text/markdown' },
        { uri: 'a2', name: 'data.json', mimeType: 'application/json; charset=utf-8' },
        { uri: 'a3', name: 'report.pdf', mimeType: 'application/pdf' },
        { uri: 'a4', name: 'bundle.zip', mimeType: 'application/zip' },
        { uri: 'a5', name: 'talk.mp4', mimeType: 'video/mp4' },
      ]}
      previews={{}}
      railRef={createRef()}
      scrollable={false}
      onOpenPreview={vi.fn()}
      onOpenText={vi.fn()}
      onRemove={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: 'Open notes.md' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Open data.json' })).toBeDefined()
  for (const name of ['report.pdf', 'bundle.zip', 'talk.mp4'])
    expect(screen.queryByRole('button', { name: `Open ${name}` })).toBeNull()
})
