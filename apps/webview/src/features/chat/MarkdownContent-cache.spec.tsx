// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownContent } from './MarkdownContent.js'

const fixture = vi.hoisted(() => ({
  cache: new Map<string, string | null>(),
  pending: new Map<string, string>(),
  requested: [] as string[],
  listeners: new Set<() => void>(),
  version: 0,
}))
vi.mock('./shiki.js', () => ({
  resolveBundledLanguage: (language: string) => (language === 'ts' ? 'typescript' : undefined),
  cachedCodeHighlight: (language: string, code: string) => fixture.cache.get(`${language}\0${code}`),
  requestCodeHighlight: (language: string, code: string) => {
    const key = `${language}\0${code}`
    if (fixture.cache.has(key) || fixture.pending.has(key)) return
    fixture.requested.push(key)
    fixture.pending.set(key, code)
  },
  subscribeCodeHighlights: (listener: () => void) => {
    fixture.listeners.add(listener)
    return () => fixture.listeners.delete(listener)
  },
  codeHighlightVersion: () => fixture.version,
}))

function complete(failed = false): void {
  act(() => {
    for (const [key, code] of fixture.pending) {
      fixture.cache.set(key, failed ? null : `<pre class="shiki"><code>${code}</code></pre>`)
      while (fixture.cache.size > 96) fixture.cache.delete(fixture.cache.keys().next().value!)
    }
    fixture.pending.clear()
    fixture.version++
    for (const listener of fixture.listeners) listener()
  })
}

beforeEach(() => {
  fixture.cache.clear()
  fixture.pending.clear()
  fixture.requested.length = 0
  fixture.version = 0
})
afterEach(cleanup)

it.each([false, true])('settles 97 completed blocks above the cache limit, shared header=%s', (shared) => {
  const markdown = Array.from(
    { length: 97 },
    (_, index) => `\`\`\`ts\n// ${shared ? 'shared' : index}\nconst value = ${index}\n\`\`\``,
  ).join('\n\n')
  const view = render(<MarkdownContent markdown={markdown} />)
  for (let round = 0; round < 8; round++) complete()
  expect(fixture.cache.size).toBe(96)
  expect(fixture.pending.size).toBe(0)
  // The first completion batch may evict one result before React observes it.
  expect(fixture.requested.length).toBeLessThanOrEqual(98)
  expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(97)
})

it('still retries a failed highlight and requests changed code after eviction', () => {
  const view = render(<MarkdownContent markdown={'```ts\n// shared\nconst value = 1\n```'} />)
  complete(true)
  expect(view.container.querySelector('pre.shiki')).toBeNull()
  fixture.cache.clear()
  complete()
  complete()
  expect(fixture.requested).toHaveLength(2)
  expect(view.container.querySelector('pre.shiki')).not.toBeNull()

  fixture.cache.clear()
  complete()
  expect(fixture.requested).toHaveLength(2)
  view.rerender(<MarkdownContent markdown={'```ts\n// shared\nconst value = 2\n```'} />)
  complete()
  expect(fixture.requested).toHaveLength(3)
  expect(view.container.querySelector('pre.shiki')?.textContent).toContain('const value = 2')
})
