// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MessageImageReference } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { MessageImages } from './MessageImages.js'

afterEach(() => cleanup())

describe('MessageImages', () => {
  it('loads a historical thumbnail and opens the original in a lightbox', async () => {
    const loadImage = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
    render(
      <I18nProvider>
        <MessageImages
          images={[
            {
              attachmentId: 'fixture:image',
              mediaType: 'image/png',
              bytes: 247,
              width: 160,
              height: 90,
              name: 'fixture-image.png',
            },
          ]}
          loadImage={loadImage}
          translate={(key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}`}
        />
      </I18nProvider>,
    )

    const thumbnail = await screen.findByRole('button', { name: /timeline\.openImage/u })
    expect(thumbnail.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')

    thumbnail.focus()
    fireEvent.click(thumbnail)
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'timeline.closeImage' }))
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(thumbnail)
  })
})

it('allows a user to retry a failed image without reopening the session', async () => {
  const image: MessageImageReference = {
    attachmentId: 'retry-image',
    mediaType: 'image/png',
    bytes: 80,
    width: 2,
    height: 1,
  }
  const loadImage = vi
    .fn()
    .mockRejectedValueOnce(new Error('disconnected'))
    .mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
  render(<MessageImages images={[image]} loadImage={loadImage} translate={(key) => key} />)
  const retry = await screen.findByRole('button', { name: 'timeline.imageRetry' })
  fireEvent.click(retry)
  const open = await screen.findByRole('button', { name: 'timeline.openImage' })
  expect(open.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
})
