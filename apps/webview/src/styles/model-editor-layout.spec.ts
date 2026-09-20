import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const compatibilityStyles = readFileSync(new URL('./compatibility.css', import.meta.url), 'utf8')

// The configured-model card regressed once: a leftover five-track template on
// the card squeezed the row into its first track, so the id and name inputs
// rendered as ~40px chips with the rest of the row empty. A stale copy of the
// same template also hid inside a `@media` block, so this suite reads every
// rule of the sheet — grouped selectors and media-scoped ones included.
describe('Configured model editor layout', () => {
  it('keeps every model card on a single track', () => {
    const templates = ruleBodies('.dsh-settings__editable-model')
      .map((body) => declaration(body, 'grid-template-columns'))
      .filter((value): value is string => value !== undefined)
    expect(templates.length).toBeGreaterThan(0)
    for (const template of templates) {
      expect(tracks(template)).toHaveLength(1)
      expect(template).not.toContain('repeat(')
    }
  })

  it('stretches the row and its advanced fields across the card', () => {
    for (const selector of ['.dsh-settings__editable-model-row', '.dsh-settings__model-advanced']) {
      expect(effective(selector, 'grid-column')).toBe('1')
      expect(effective(selector, 'width')).toBe('100%')
      expect(effective(selector, 'box-sizing')).toBe('border-box')
    }
  })

  it('splits the row between the two fractional input columns', () => {
    const templates = ruleBodies('.dsh-settings__editable-model-row')
      .map((body) => declaration(body, 'grid-template-columns'))
      .filter((value): value is string => value !== undefined)
    const shared = templates.some((template) => {
      const columns = tracks(template)
      return columns.length >= 2 && isFractionalTrack(columns[0] ?? '') && isFractionalTrack(columns[1] ?? '')
    })
    expect(shared).toBe(true)
  })

  it('lays out the editor header as a wrapping flex row', () => {
    for (const selector of ['.dsh-settings__model-editor-head', '.dsh-settings__model-editor-actions']) {
      expect(effective(selector, 'display')).toBe('flex')
      expect(effective(selector, 'flex-wrap')).toBe('wrap')
    }
  })
})

/** Declarations seen last in the sheet win, so the last body that names a property carries it. */
function effective(selector: string, property: string): string | undefined {
  let value: string | undefined
  for (const body of ruleBodies(selector)) {
    const declared = declaration(body, property)
    if (declared !== undefined) value = declared
  }
  return value
}

function ruleBodies(selector: string): readonly string[] {
  const source = compatibilityStyles.replace(/\/\*[\s\S]*?\*\//gu, '')
  const bodies: string[] = []
  for (const match of source.matchAll(/(?:^|\n)([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim())
    if (selectors.includes(selector)) bodies.push(match[2] ?? '')
  }
  return bodies
}

function declaration(body: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u').exec(body)
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Track lists are space-separated; `repeat()` expands in place. */
function tracks(template: string): readonly string[] {
  const tokens: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at <= template.length; at += 1) {
    const char = template[at]
    if (at === template.length || (char !== undefined && /\s/u.test(char) && depth === 0)) {
      const token = template.slice(start, at).trim()
      if (token !== '') tokens.push(token)
      start = at + 1
    } else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
  }
  return tokens.flatMap(expandTrack)
}

function expandTrack(track: string): readonly string[] {
  const repeat = /^repeat\(\s*([^,]+?)\s*,(.*)\)$/u.exec(track)
  if (repeat === null) return [track]
  const count = Number(repeat[1])
  // A non-numeric repeat (`auto-fill`, `auto-fit`) is a multi-column signal of
  // its own, so it reports two tracks and fails a single-track expectation.
  if (!Number.isInteger(count) || count < 1) return [track, track]
  return Array.from({ length: count }, () => (repeat[2] ?? '').trim())
}

function isFractionalTrack(track: string): boolean {
  return /^(?:minmax\(\s*0\s*,\s*[\d.]+fr\s*\)|[\d.]+fr)$/u.test(track)
}
