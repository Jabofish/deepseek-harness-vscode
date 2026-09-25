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

/** Host-driven sizes that must not become tokens: the Webview root font and its scaled body copy. */
const HOST_FONT_SIZES = new Set([
  'var(--vscode-font-size, 13px)',
  'calc(var(--vscode-font-size, 13px) * var(--dsh-conversation-font-scale))',
])

const webviewSrc = fileURLToPath(new URL('../../', import.meta.url))
const uiStyles = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

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
      [...appStyles.matchAll(/--dsh-font-size-([a-z0-9]+):\s*calc\(([^;]+)\);/gu)].map((match) => [
        match[1]!,
        match[2]!.trim(),
      ]),
    )
    expect([...scaled.keys()]).toEqual([...STEPS.keys()])
    for (const [step, value] of STEPS)
      expect(scaled.get(step)).toBe(`${value} * var(--dsh-conversation-font-scale)`)
  })

  it('keeps every font-size on a scale token', () => {
    const offenders = scanFontSizes()
      .filter((declaration) => !HOST_FONT_SIZES.has(declaration.value))
      .filter((declaration) => declaration.value !== 'inherit')
      .filter((declaration) => !/^var\(--dsh-[a-z0-9-]+\)$/u.test(declaration.value))
      .map((declaration) => `${declaration.file}:${declaration.line} → font-size: ${declaration.value}`)
    expect(offenders).toEqual([])
  })

  it('keeps headings off the browser default scale', () => {
    const fallback = appStyles.match(
      /:where\(\s*h1\s*,\s*h2\s*,\s*h3\s*,\s*h4\s*,\s*h5\s*,\s*h6\s*\)\s*\{\s*font-size:\s*([^;]+);/u,
    )
    expect(fallback?.[1]?.trim()).toBe('var(--dsh-font-size-lg)')
  })
})
