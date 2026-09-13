// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeClipboard } from './clipboard.js'

const stubClipboard = (writeText: (text: string) => Promise<void>): void => {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
}

const stubLegacyCopy = (result: boolean | Error): ReturnType<typeof vi.fn> => {
  const execCommand = vi.fn(() => {
    if (result instanceof Error) throw result
    return result
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: execCommand })
  return execCommand
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'execCommand')
  for (const textarea of document.querySelectorAll('textarea')) textarea.remove()
})

describe('writeClipboard', () => {
  it('uses the Webview clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const execCommand = stubLegacyCopy(true)
    stubClipboard(writeText)

    await expect(writeClipboard('hello')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to a DOM copy when the clipboard API refuses the write', async () => {
    // A Webview whose iframe policy denies clipboard-write still exposes
    // `navigator.clipboard`, but every write rejects with NotAllowedError.
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'))
    const execCommand = stubLegacyCopy(true)
    stubClipboard(writeText)

    await expect(writeClipboard('hello')).resolves.toBe(true)

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('reports a failed DOM copy instead of rejecting', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    const execCommand = stubLegacyCopy(false)

    await expect(writeClipboard('hello')).resolves.toBe(false)

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('reports a throwing DOM copy instead of rejecting and still cleans up', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    stubLegacyCopy(new Error('copy is not supported'))

    await expect(writeClipboard('hello')).resolves.toBe(false)

    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('uses the DOM copy when the clipboard API is missing entirely', async () => {
    vi.stubGlobal('navigator', {})
    const execCommand = stubLegacyCopy(true)

    await expect(writeClipboard('hello')).resolves.toBe(true)

    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
