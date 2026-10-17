import { readStylesheet } from '../../../../scripts/read-stylesheet.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const STEPS = new Map([
  ['2xs', '0.625rem'],
  ['xs', '0.75rem'],
  ['sm', '0.8125rem'],
  ['md', '0.875rem'],
  ['lg', '1rem'],
])

/**
 * Steps the reference client keeps at a fixed size: the smallest text on screen is 10px there,
 * so these floor at their baseline instead of tracking the conversation font setting downward.
 */
const FLOORED_STEPS = new Set(['2xs', 'xs'])

/** Host-driven sizes that must not become tokens: the Webview root font and its scaled body copy. */
const HOST_FONT_SIZES = new Set([
  'var(--vscode-font-size, 13px)',
  'calc(var(--vscode-font-size, 13px) * var(--dsh-conversation-font-scale))',
])

const webviewSrc = fileURLToPath(new URL('../../', import.meta.url))
const uiStyles = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8')
const appStyles = readStylesheet(new URL('./app.css', import.meta.url), [
  new URL('./compatibility.css', import.meta.url),
])
const layoutStyles = readStylesheet(new URL('./layout.css', import.meta.url))
const selectionStyles = readFileSync(new URL('./components/02-selection.css', import.meta.url), 'utf8')

function blankComments(stylesheet: string): string {
  return stylesheet.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
}

function collectStylesheets(directory: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...collectStylesheets(join(directory, entry.name), relative))
    } else if (entry.name.endsWith('.css')) {
      files.push(relative)
    }
  }
  return files.sort()
}

function scanFontSizes(): { file: string; line: number; value: string }[] {
  const found: { file: string; line: number; value: string }[] = []
  for (const file of collectStylesheets(webviewSrc)) {
    const stylesheet = blankComments(readFileSync(join(webviewSrc, file), 'utf8'))
    for (const match of stylesheet.matchAll(/font-size:\s*([^;{}]+)/gu)) {
      found.push({
        file,
        line: stylesheet.slice(0, match.index).split('\n').length,
        value: match[1]!.trim().replace(/\s*!important$/u, ''),
      })
    }
  }
  return found
}

describe('Webview typography scale', () => {
  it('declares the five-step scale in the UI package', () => {
    const declared = new Map(
      [...uiStyles.matchAll(/--dsh-font-size-([a-z0-9]+):\s*([^;]+);/gu)].map((match) => [
        match[1]!,
        match[2]!.trim(),
      ]),
    )
    expect(declared).toEqual(STEPS)
  })

  it('re-derives every step inside the conversation font scale', () => {
    const scaled = new Map(
      [...appStyles.matchAll(/--dsh-font-size-([a-z0-9]+):\s*([^;]+);/gu)].map((match) => [
        match[1]!,
        match[2]!.trim(),
      ]),
    )
    expect([...scaled.keys()]).toEqual([...STEPS.keys()])
    for (const [step, value] of STEPS) {
      const scaledValue = `calc(${value} * var(--dsh-conversation-font-scale))`
      // The caption steps are pinned to their baseline: shrinking the setting tracks content
      // size, so an unbounded multiplier put 2xs at 8.6px on the 12px setting.
      expect(scaled.get(step)).toBe(FLOORED_STEPS.has(step) ? `max(${value}, ${scaledValue})` : scaledValue)
    }
  })

  it('keeps every font-size on a scale token', () => {
    const offenders = scanFontSizes()
      .filter((declaration) => !HOST_FONT_SIZES.has(declaration.value))
      .filter((declaration) => declaration.value !== 'inherit')
      .filter((declaration) => !/^var\(--dsh-[a-z0-9-]+\)$/u.test(declaration.value))
      .map((declaration) => `${declaration.file}:${declaration.line} → font-size: ${declaration.value}`)
    expect(offenders).toEqual([])
  })

  it('rebinds every font role alias to the local conversation scale', () => {
    const conversation = appStyles.match(/\.dsh-conversation\s*\{([^}]+)\}/u)?.[1]
    const aliases = [...uiStyles.matchAll(/(--dsh-[a-z0-9-]+):\s*(var\(--dsh-font-size-[a-z0-9]+\));/gu)]
    expect(aliases.length).toBeGreaterThan(0)
    for (const [, role, value] of aliases) {
      expect(conversation, role).toContain(`${role}: ${value};`)
    }
  })

  it('gives plain and wrapped conversation menu entries the same text role', () => {
    const entries = layoutStyles.match(
      /\.dsh-conversation__actions-grid > button,\s*\.dsh-conversation__actions-grid > \* > button\s*\{([^}]+)\}/u,
    )?.[1]
    expect(entries).toContain('font-family: inherit;')
    expect(entries).toContain('font-size: var(--dsh-menu-font-size);')
    expect(entries).toContain('font-weight: 400;')
    expect(entries).toContain('line-height: var(--dsh-menu-line-height);')
  })

  it('gives shared choice menus an explicit role instead of their surrounding form font', () => {
    const menu = selectionStyles.match(/\.dsh-select-menu__menu\s*\{([^}]+)\}/u)?.[1]
    expect(menu).toContain('font-size: var(--dsh-menu-font-size);')
    expect(menu).toContain('font-weight: 400;')
    expect(menu).toContain('line-height: var(--dsh-menu-line-height);')
    const option = selectionStyles.match(/\.dsh-select-menu__option\s*\{([^}]+)\}/u)?.[1]
    expect(option).toContain('font: inherit;')
  })

  it('keeps headings off the browser default scale', () => {
    const fallback = appStyles.match(
      /:where\(\s*h1\s*,\s*h2\s*,\s*h3\s*,\s*h4\s*,\s*h5\s*,\s*h6\s*\)\s*\{\s*font-size:\s*([^;]+);/u,
    )
    expect(fallback?.[1]?.trim()).toBe('var(--dsh-font-size-lg)')
  })
})
