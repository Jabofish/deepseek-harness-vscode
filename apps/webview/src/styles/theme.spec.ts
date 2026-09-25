import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const themeStyles = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const uiStyles = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8')
const webviewSrc = fileURLToPath(new URL('../../', import.meta.url))

function collectStylesheets(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...collectStylesheets(`${directory}/${entry.name}`))
    else if (entry.name.endsWith('.css')) files.push(`${directory}/${entry.name}`)
  }
  return files
}

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
  it('defines explicit palettes while leaving system mode host-driven', () => {
    expect(themeStyles).toContain("html[data-dsh-theme='light']")
    expect(themeStyles).toContain("html[data-dsh-theme='dark']")
    expect(themeStyles).toContain("html[data-dsh-theme='system']")
    expect(themeStyles).toContain('color-scheme: light dark;')
    expect(themeStyles).not.toContain('@media (prefers-color-scheme: dark)')
    expect(themeStyles).toMatch(/--dsh-theme-bg:\s*#f7f8fa;/u)
    expect(themeStyles).toMatch(/--dsh-theme-bg:\s*#1f2023;/u)
  })

  it('projects explicit palettes onto DSH tokens without redefining VS Code colors', () => {
    for (const token of [
      '--dsh-bg',
      '--dsh-surface',
      '--dsh-text',
      '--dsh-muted',
      '--dsh-primary',
      '--dsh-input-bg',
      '--dsh-code-bg',
    ])
      expect(themeStyles).toContain(`${token}: var(--dsh-theme-`)

    expect(themeStyles).toContain(
      '--dsh-selection-bg: var(--vscode-list-activeSelectionBackground, var(--dsh-control-hover));',
    )
    expect(themeStyles).not.toMatch(/--vscode-[^:]+:\s*var\(--dsh-theme-/u)
  })

  it('keeps code identifiers and scrollports on semantic themed surfaces', () => {
    expect(appStyles).toContain('.dsh-app code')
    expect(appStyles).toContain('background: var(--dsh-code-bg);')
    expect(themeStyles).toMatch(/--dsh-scrollbar-thumb:\s*var\(\s*--vscode-scrollbarSlider-background,/u)
    expect(themeStyles).toContain('scrollbar-color: var(--dsh-scrollbar-thumb) var(--dsh-scrollbar-track);')
    expect(themeStyles).toContain('::-webkit-scrollbar-thumb:hover')
    expect(themeStyles).toContain('--dsh-theme-scrollbar-thumb: #b7bec9;')
  })

  it('keeps provider protocol menus inside the themed control surface', () => {
    expect(appStyles).toMatch(
      /\.dsh-settings__provider-api-select,\s*\.dsh-settings__provider-api-select \.dsh-select-menu__trigger\s*\{\s*width: 100%;/u,
    )
    expect(appStyles).toContain('background: var(--dsh-control-background);')
  })

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

  it('paints accent strokes with the line token, never with the fill token', () => {
    expect(uiStyles).toContain('--dsh-accent-line: var(--dsh-link);')
    expect(themeStyles).toContain('--dsh-link: var(--dsh-theme-link);')

    // `--dsh-focus` always resolves (styles.css base + theme alias), so the accent
    // fallback inside those declarations is unreachable and stays out of this guard.
    const LINE_PROPERTY =
      /^(?:color|border[a-z-]*|outline[a-z-]*|box-shadow|text-decoration[a-z-]*|fill|stroke)$/u
    const FILL_TOKEN = /var\(--dsh-(?:accent|primary)\)/u
    const offenders: string[] = []
    for (const file of [uiStyles, ...collectStylesheets(webviewSrc)]) {
      const css = file.replace(/\/\*[\s\S]*?\*\//gu, '')
      for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        const selector = block[1]!.trim().replace(/\s+/gu, ' ')
        const declarations = block[2]!.split(';')
        const isFill = declarations.some((declaration) =>
          /^\s*background(?:-color)?:\s*[^;]*var\(--dsh-primary\)/u.test(declaration),
        )
        for (const declaration of declarations) {
          const [property, ...value] = declaration.split(':')
          if (property === undefined || !LINE_PROPERTY.test(property.trim())) continue
          const strokes = value.join(':').replace(/var\(--dsh-focus,[^()]*(?:\([^()]*\))?[^()]*\)/gu, '')
          if (FILL_TOKEN.test(strokes) && !isFill) offenders.push(`${selector} -> ${declaration.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
