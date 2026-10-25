// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComposerAttachmentsRail } from './ComposerAttachmentsRail.js'

afterEach(() => {
  cleanup()
  document.body.className = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['body', 'media'] as const)(
  'stops attachment paging when the %s motion preference changes and releases the subscription',
  async (source) => {
    const events = new EventTarget()
    const media = {
      matches: false,
      addEventListener: vi.fn(events.addEventListener.bind(events)),
      removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    }
    vi.stubGlobal('matchMedia', () => media)
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const railRef = createRef<HTMLUListElement>()
    const props = {
      previews: {},
      railRef,
      scrollable: true,
      onOpenPreview: vi.fn(),
      onRemove: vi.fn(),
    }
    const view = render(<ComposerAttachmentsRail {...props} attachments={[]} />)
    view.rerender(
      <ComposerAttachmentsRail
        {...props}
        attachments={[{ uri: 'dsh-attachment:fixture', name: 'fixture.txt' }]}
      />,
    )
    const rail = railRef.current!
    const scrollBy = vi.fn()
    const scrollTo = vi.fn()
    rail.scrollBy = scrollBy
    rail.scrollTo = scrollTo
    const next = view.getByRole('button', { name: 'Show next attachments' })
    fireEvent.click(next)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 160, behavior: 'smooth' })
    rail.scrollLeft = 88
    const setReduced = async (reduced: boolean): Promise<void> => {
      await act(async () => {
        if (source === 'body') document.body.classList.toggle('vscode-reduce-motion', reduced)
        else {
          media.matches = reduced
          events.dispatchEvent(new Event('change'))
        }
        await Promise.resolve()
      })
    }
    await setReduced(true)
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 88, behavior: 'instant' })
    fireEvent.click(next)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 160, behavior: 'auto' })
    await setReduced(false)
    fireEvent.click(next)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 160, behavior: 'smooth' })
    expect(media.addEventListener).toHaveBeenCalledOnce()
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(media.removeEventListener).toHaveBeenCalledExactlyOnceWith(
      'change',
      media.addEventListener.mock.calls[0]?.[1],
    )
    await setReduced(true)
    expect(scrollTo).toHaveBeenCalledOnce()
  },
)
