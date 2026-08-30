import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const uiStyles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const webviewStylePaths = [
  '../../../apps/webview/src/styles/app.css',
  '../../../apps/webview/src/styles/components.css',
  '../../../apps/webview/src/styles/layout.css',
  '../../../apps/webview/src/styles/compatibility.css',
] as const

const webviewStyles = webviewStylePaths.map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

describe('motion system', () => {
  it('keeps the shared motion tokens stable and complete', () => {
    const tokens = {
      '--dsh-motion-duration-fast': '120ms',
      '--dsh-motion-duration-standard': '180ms',
      '--dsh-motion-duration-slow': '240ms',
      '--dsh-motion-duration-loop-shimmer': '1.4s',
      '--dsh-motion-duration-loop-pulse': '1.8s',
      '--dsh-motion-duration-loop-breathe': '2.8s',
      '--dsh-motion-ease-standard': 'cubic-bezier(0.2, 0, 0, 1)',
      '--dsh-motion-ease-enter': 'cubic-bezier(0, 0, 0, 1)',
      '--dsh-motion-ease-exit': 'cubic-bezier(0.3, 0, 1, 1)',
      '--dsh-motion-ease-emphasized-enter': 'cubic-bezier(0.05, 0.7, 0.1, 1)',
      '--dsh-motion-ease-pop': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      '--dsh-motion-scale-from': '0.97',
      '--dsh-motion-scale-press': '0.98',
      '--dsh-motion-scale-pulse': '0.75',
    }

    for (const [name, value] of Object.entries(tokens)) {
      expect(uiStyles).toMatch(new RegExp(`${escapeRegExp(name)}\\s*:\\s*${escapeRegExp(value)}\\s*;`))
    }
  })

  it('keeps all shared keyframes in the UI style owner', () => {
    const keyframes = [
      'dsh-surface-enter',
      'dsh-overlay-fade-in',
      'dsh-overlay-fade-out',
      'dsh-slide-in-end',
      'dsh-slide-in-start',
      'dsh-slide-out-end',
      'dsh-slide-out-start',
      'dsh-pop-in',
      'dsh-rise-in',
      'dsh-toast-in',
      'dsh-retry-shimmer',
      'dsh-pulse-dot',
      'dsh-breathe',
      'dsh-skeleton-sweep',
      'dsh-pop-once',
    ]

    for (const name of keyframes) expect(uiStyles).toContain(`@keyframes ${name}`)
    expect(webviewStyles.join('\n')).not.toMatch(/@keyframes\s+dsh-/u)
  })

  it('has one global Reduced Motion policy', () => {
    expect(uiStyles.match(/prefers-reduced-motion\s*:\s*reduce/gu)).toHaveLength(1)
    expect(webviewStyles.join('\n')).not.toMatch(/prefers-reduced-motion\s*:\s*reduce/u)
  })

  it('does not put raw animation or transition durations in feature styles', () => {
    const rawDuration = /(?:animation|transition)(?:-[\w-]+)?\s*:[^;{}]*\b\d+(?:\.\d+)?(?:ms|s)\b/giu
    for (const styles of webviewStyles) expect(styles).not.toMatch(rawDuration)
  })

  it('uses motion tokens for the retry shimmer', () => {
    const compatibility = webviewStyles[3]
    expect(compatibility).toBeDefined()
    if (compatibility === undefined) return
    expect(compatibility.replace(/\s+/gu, ' ')).toContain(
      'animation: dsh-retry-shimmer var(--dsh-motion-duration-loop-shimmer) var(--dsh-motion-ease-standard) infinite;',
    )
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
