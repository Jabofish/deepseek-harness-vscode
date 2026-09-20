// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, type ReactElement } from 'react'
import type { MessageImageReference } from '@dsh-vscode/domain'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
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

  it('returns focus to the thumbnail after the lightbox closes', async () => {
    const loadImage = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
    render(
      <I18nProvider>
        <MessageImages
          images={[
            {
              attachmentId: 'fixture:focus',
              mediaType: 'image/png',
              bytes: 247,
              width: 160,
              height: 90,
              name: 'focus.png',
            },
          ]}
          loadImage={loadImage}
          translate={(key) => key}
        />
      </I18nProvider>,
    )

    const thumbnail = await screen.findByRole('button', { name: 'timeline.openImage' })
    fireEvent.click(thumbnail)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'timeline.closeImage' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(thumbnail)
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

  it('reuses a loaded image when it leaves and re-enters the rendered window', async () => {
    const loadImage = vi.fn().mockResolvedValue('data:image/png;base64,cached')
    const image: MessageImageReference = {
      attachmentId: 'cached:image',
      mediaType: 'image/png',
      bytes: 12,
      width: 16,
      height: 16,
      name: 'cached.png',
    }
    const { rerender } = render(
      <I18nProvider>
        <MessageImages images={[image]} loadImage={loadImage} translate={(key) => key} />
      </I18nProvider>,
    )

    await screen.findByRole('button', { name: 'timeline.openImage' })
    rerender(
      <I18nProvider>
        <MessageImages images={[]} loadImage={loadImage} translate={(key) => key} />
      </I18nProvider>,
    )
    rerender(
      <I18nProvider>
        <MessageImages images={[image]} loadImage={loadImage} translate={(key) => key} />
      </I18nProvider>,
    )

    await screen.findByRole('button', { name: 'timeline.openImage' })
    expect(loadImage).toHaveBeenCalledTimes(1)
  })

  it('retries a failed thumbnail when the host re-publishes the row', async () => {
    const loadImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('the connection dropped mid-read'))
      .mockResolvedValue('data:image/png;base64,recovered')
    const image: MessageImageReference = {
      attachmentId: 'retry:image',
      mediaType: 'image/png',
      bytes: 12,
      width: 16,
      height: 16,
      name: 'retry.png',
    }
    const { rerender } = render(
      <I18nProvider>
        <MessageImages images={[image]} loadImage={loadImage} translate={(key) => key} />
      </I18nProvider>,
    )

    await screen.findByRole('alert')
    // A reconnect reopens the session, so the store republishes every row with
    // fresh objects: the failure belonged to a connection that no longer exists.
    rerender(
      <I18nProvider>
        <MessageImages images={[{ ...image }]} loadImage={loadImage} translate={(key) => key} />
      </I18nProvider>,
    )

    const thumbnail = await screen.findByRole('button', { name: 'timeline.openImage' })
    expect(thumbnail.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,recovered')
    expect(loadImage).toHaveBeenCalledTimes(2)
  })

  it('stops retrying an unavailable image after a bounded number of attempts', async () => {
    const loadImage = vi.fn().mockResolvedValue(undefined)
    const image: MessageImageReference = {
      attachmentId: 'gone:image',
      mediaType: 'image/png',
      bytes: 12,
      width: 16,
      height: 16,
      name: 'gone.png',
    }
    const { rerender } = render(
      <I18nProvider>
        <MessageImages images={[image]} loadImage={loadImage} translate={(key) => key} />
      </I18nProvider>,
    )
    for (let republication = 0; republication < 5; republication += 1) {
      await screen.findByRole('alert')
      rerender(
        <I18nProvider>
          <MessageImages images={[{ ...image }]} loadImage={loadImage} translate={(key) => key} />
        </I18nProvider>,
      )
    }

    await screen.findByRole('alert')
    expect(loadImage).toHaveBeenCalledTimes(3)
  })

  it('leaves Escape to a layer that already consumed it', async () => {
    const loadImage = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
    const onEscape = vi.fn()
    function Consumer(): ReactElement {
      const ref = useRef<HTMLDivElement>(null)
      useDismissibleLayer({ open: true, refs: [ref], onDismiss: () => undefined, onEscape })
      return <div ref={ref} />
    }
    render(
      <I18nProvider>
        <Consumer />
        <MessageImages
          images={[
            {
              attachmentId: 'fixture:escape',
              mediaType: 'image/png',
              bytes: 247,
              width: 160,
              height: 90,
              name: 'escape.png',
            },
          ]}
          loadImage={loadImage}
          translate={(key) => key}
        />
      </I18nProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'timeline.openImage' }))
    expect(screen.getByRole('dialog')).toBeDefined()

    // The key targets a node inside the document, so it reaches the layer's
    // document listener before the lightbox's window listener -- the order a
    // real key press takes.
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeDefined()
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
  await screen.findByRole('button', { name: 'timeline.openImage' })
  expect(loadImage).toHaveBeenCalledTimes(2)
})
