// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('shiki', () => ({ createHighlighter: vi.fn() }))

const highlighter = {
  loadLanguage: vi.fn(),
  codeToHtml: vi.fn(),
  codeToTokensWithThemes: vi.fn(),
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('getWebviewHighlighter', () => {
  it('retries after a transient load failure instead of caching the rejection', async () => {
    const { createHighlighter } = await import('shiki')
    const create = vi.mocked(createHighlighter)
    create
      .mockRejectedValueOnce(new Error('failed to fetch dynamically imported module'))
      .mockResolvedValueOnce(highlighter as never)
    const { getWebviewHighlighter } = await import('./shiki.js')

    await expect(getWebviewHighlighter()).rejects.toThrow('failed to fetch dynamically imported module')
    // The chat keeps rendering after a failed grammar chunk; the next code block
    // must be able to highlight once the load succeeds.
    await expect(getWebviewHighlighter()).resolves.toBe(highlighter)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('shares one highlighter across concurrent and later callers', async () => {
    const { createHighlighter } = await import('shiki')
    const create = vi.mocked(createHighlighter)
    create.mockResolvedValue(highlighter as never)
    const { getWebviewHighlighter } = await import('./shiki.js')

    const [first, second] = await Promise.all([getWebviewHighlighter(), getWebviewHighlighter()])

    expect(first).toBe(highlighter)
    expect(second).toBe(highlighter)
    expect(await getWebviewHighlighter()).toBe(highlighter)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
