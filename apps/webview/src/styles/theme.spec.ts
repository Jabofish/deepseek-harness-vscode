import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const themeStyles = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

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
})
