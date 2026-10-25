// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { pageAttachmentRail } from './composer-input.js'

afterEach(() => {
  document.body.className = ''
  vi.unstubAllGlobals()
})

it('pages attachments using the current shared motion policy in both directions', () => {
  const media = { matches: false }
  vi.stubGlobal('matchMedia', () => media)
  const rail = document.createElement('ul')
  Object.defineProperty(rail, 'clientWidth', { value: 240 })
  const scrollBy = vi.fn()
  rail.scrollBy = scrollBy
  pageAttachmentRail(rail, 1)
  expect(scrollBy).toHaveBeenLastCalledWith({ left: 192, behavior: 'smooth' })
  document.body.classList.add('vscode-reduce-motion')
  pageAttachmentRail(rail, -1)
  expect(scrollBy).toHaveBeenLastCalledWith({ left: -192, behavior: 'auto' })
  document.body.className = ''
  media.matches = true
  pageAttachmentRail(rail, 1)
  expect(scrollBy).toHaveBeenLastCalledWith({ left: 192, behavior: 'auto' })
  media.matches = false
  pageAttachmentRail(rail, -1)
  expect(scrollBy).toHaveBeenLastCalledWith({ left: -192, behavior: 'smooth' })
  expect(() => pageAttachmentRail(null, 1)).not.toThrow()
})
