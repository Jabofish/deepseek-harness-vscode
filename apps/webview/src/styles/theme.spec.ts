import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const themeStyles = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')

/** Palette tokens of one explicit theme, restricted to plain hex values. */
function palette(theme: string): Map<string, string> {
  const blocks = themeStyles.match(new RegExp(`\\[data-dsh-theme='${theme}'\\][^{]*\\{([^}]*)\\}`, 'gu'))
  const tokens = new Map<string, string>()
  for (const block of blocks ?? []) {
    for (const [, token, value] of block.matchAll(/(--dsh-theme-[a-z0-9-]+):\s*([^;]+);/gu)) {
      const trimmedValue = value?.trim()
      if (trimmedValue !== undefined && /^#[0-9a-f]{6}$/iu.test(trimmedValue))
        tokens.set(token!, trimmedValue)
    }
  }
  return tokens
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (raw: number): number => {
    const scaled = raw / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  )
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

/** Foreground/background pairs that carry text: WCAG AA needs 4.5:1. */
const TEXT_PAIRS: [string, string][] = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-raised'],
  ['text', 'surface-soft'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-raised'],
  ['muted', 'surface-soft'],
  ['placeholder', 'input-bg'],
  ['icon', 'surface'],
  ['icon', 'surface-soft'],
  ['link', 'bg'],
  ['link', 'surface'],
  ['link', 'surface-raised'],
  ['link', 'surface-soft'],
  ['link', 'surface-hover'],
  ['link', 'secondary'],
  ['link', 'input-bg'],
  ['secondary-text', 'secondary'],
  ['badge-text', 'badge-bg'],
  ['active-text', 'active-bg'],
  ['primary-text', 'primary'],
  ['primary-text', 'primary-hover'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['danger', 'danger-bg'],
  ['success', 'bg'],
  ['success', 'surface'],
  ['warning', 'surface'],
  ['warning', 'warning-bg'],
  ['info', 'surface'],
  ['chart-green', 'surface'],
  ['chart-red', 'surface'],
  ['chart-yellow', 'surface'],
  ['chart-blue', 'surface'],
]

/** Boundaries that identify a control or a focused element: 3:1. */
const UI_PAIRS: [string, string][] = [
  ['input-border', 'input-bg'],
  ['input-border', 'surface'],
  ['focus', 'surface'],
  ['warning-border', 'surface'],
  ['error-border', 'surface'],
]

function ratioFor(theme: string, foreground: string, background: string): number {
  const tokens = palette(theme)
  const fg = tokens.get(`--dsh-theme-${foreground}`)
  const bg = tokens.get(`--dsh-theme-${background}`)
  if (fg === undefined || bg === undefined)
    throw new Error(`missing ${foreground} or ${background} in ${theme}`)
  return contrast(fg, bg)
}

describe('Webview theme contract', () => {
  it('keeps every palette pair that carries text at WCAG AA', () => {
    for (const theme of ['light', 'dark']) {
      const failures = TEXT_PAIRS.map(([foreground, background]) => ({
        pair: `${foreground} on ${background}`,
        ratio: ratioFor(theme, foreground, background),
      }))
        .filter((entry) => entry.ratio < 4.5)
        .map((entry) => `${theme} ${entry.pair} = ${entry.ratio.toFixed(2)}`)
      expect(failures).toEqual([])
    }
  })

  it('keeps control boundaries and focus rings at 3:1', () => {
    for (const theme of ['light', 'dark']) {
      const failures = UI_PAIRS.map(([foreground, background]) => ({
        pair: `${foreground} on ${background}`,
        ratio: ratioFor(theme, foreground, background),
      }))
        .filter((entry) => entry.ratio < 3)
        .map((entry) => `${theme} ${entry.pair} = ${entry.ratio.toFixed(2)}`)
      expect(failures).toEqual([])
    }
  })
})
