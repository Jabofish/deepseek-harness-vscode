// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(loadImage).toHaveBeenCalledTimes(1)
    expect(thumbnail.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(thumbnail.getAttribute('style')).toContain('aspect-ratio')

    fireEvent.click(thumbnail)
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps an unavailable historical image as a bounded placeholder', async () => {
    const loadImage = vi.fn().mockResolvedValue(undefined)
    render(
      <I18nProvider>
        <MessageImages
          images={[
            {
              attachmentId: 'missing:image',
              mediaType: 'image/jpeg',
              bytes: 12,
              width: 10_000,
              height: 1,
              name: 'very-long-image-name-that-must-not-widen-the-chat-card.jpg',
            },
          ]}
          loadImage={loadImage}
          translate={(key) => key}
        />
      </I18nProvider>,
    )

    const placeholder = await screen.findByRole('alert')
    expect(placeholder.textContent).toContain('timeline.imageUnavailable')
    expect(placeholder.className).toContain('dsh-message-images__placeholder')
  })
})
