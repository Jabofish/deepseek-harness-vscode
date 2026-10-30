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
  document.body.replaceChildren()
})

describe('writeClipboard', () => {
  it.each([true, false, new Error('copy unavailable')])(
    'preserves the input focus and caret after a fallback copy result: %s',
    async (result) => {
      vi.stubGlobal('navigator', {})
      stubLegacyCopy(result)
      const prompt = document.createElement('textarea')
      prompt.value = 'draft stays editable'
      document.body.append(prompt)
      prompt.focus()
      prompt.setSelectionRange(6, 11)
      await expect(writeClipboard('copied answer')).resolves.toBe(result === true)
      expect(document.activeElement).toBe(prompt)
      expect(prompt.value.slice(prompt.selectionStart, prompt.selectionEnd)).toBe('stays')
      expect(document.querySelector('[data-dsh-clipboard-fallback]')).toBeNull()
    },
  )

  it("restores the reader's text selection after the temporary copy selection is cleared", async () => {
    vi.stubGlobal('navigator', {})
    const paragraph = document.createElement('p')
    paragraph.textContent = 'Selected answer'
    document.body.append(paragraph)
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const execCommand = stubLegacyCopy(true)
    execCommand.mockImplementation(() => {
      selection.removeAllRanges()
      return true
    })
    await expect(writeClipboard('another copied payload')).resolves.toBe(true)
    expect(selection.toString()).toBe('Selected answer')
  })

  it('respects a new focus choice made by a copy handler', async () => {
    vi.stubGlobal('navigator', {})
    const original = document.createElement('button')
    const next = document.createElement('button')
    document.body.append(original, next)
    original.focus()
    stubLegacyCopy(true).mockImplementation(() => {
      next.focus()
      return true
    })
    await expect(writeClipboard('payload')).resolves.toBe(true)
    expect(document.activeElement).toBe(next)
  })

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

  it('reports a throwing DOM copy instead of rejecting and still cleans up', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    stubLegacyCopy(new Error('copy is not supported'))

    await expect(writeClipboard('hello')).resolves.toBe(false)

    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})
