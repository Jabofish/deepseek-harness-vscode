import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// `app.css` imports the compatibility sheet first, so a later `app.css` rule wins
// at equal specificity; reading both in cascade order answers "what applies".
const cascade =
  readFileSync(new URL('./compatibility.css', import.meta.url), 'utf8') +
  '\n' +
  readFileSync(new URL('./app.css', import.meta.url), 'utf8')

// The provider card once shared one wrapping flex row with its buttons, so a long
// provider id pushed the edit/remove cluster onto a line of its own and left half
// the card empty. The head is a two-column grid now: the identity chips wrap in
// the first column and the buttons hold the end of the first row.
describe('Provider card layout', () => {
  it('pins the action cluster to the end of the first row', () => {
    // No group rule may turn the head back into a flex row.
    for (const value of declared('.dsh-settings__provider-head', 'display')) expect(value).toBe('grid')

    const template = effective('.dsh-settings__provider-head', 'grid-template-columns')
    expect(template).toBeDefined()
    const columns = tracks(template ?? '')
    expect(columns).toHaveLength(2)
    expect(columns[0]).toMatch(/[\d.]+fr/u)
    expect(columns[1]).toBe('auto')
    expect(effective('.dsh-settings__provider-actions', 'justify-content')).toBe('flex-end')
  })

  it('lets the identity chips wrap inside their column', () => {
    expect(effective('.dsh-settings__provider-identity', 'display')).toBe('flex')
    expect(effective('.dsh-settings__provider-identity', 'flex-wrap')).toBe('wrap')
    expect(effective('.dsh-settings__provider-identity', 'min-width')).toBe('0')
  })

  it('keeps the model count and the credential controls on one wrapping row', () => {
    // The summary used to be a grid track of the card, which stacked the count
    // above the credential controls.
    for (const value of declared('.dsh-settings__provider-summary', 'display')) expect(value).toBe('flex')

    expect(effective('.dsh-settings__provider-summary', 'flex-wrap')).toBe('wrap')
    expect(effective('.dsh-settings__provider-summary', 'min-width')).toBe('0')
  })

  it('keeps the provider id quiet next to the name it repeats', () => {
    expect(effective('.dsh-settings__provider-identity code', 'color')).toBe('var(--dsh-muted)')
    const size = effective('.dsh-settings__provider-identity code', 'font-size') ?? ''
    expect(Number.parseFloat(size)).toBeLessThan(1)
    expect(effective('.dsh-settings__provider-identity code', 'text-overflow')).toBe('ellipsis')
  })
})

/** Every declared value in the cascade, grouped selectors included. */
function declared(selector: string, property: string): readonly string[] {
  return ruleBodies(selector)
    .map((body) => declaration(body, property))
    .filter((value): value is string => value !== undefined)
}

/** Declarations seen last in the cascade win, so the last body that names a property carries it. */
function effective(selector: string, property: string): string | undefined {
  let value: string | undefined
  for (const body of ruleBodies(selector)) {
    const found = declaration(body, property)
    if (found !== undefined) value = found
  }
  return value
}

function ruleBodies(selector: string): readonly string[] {
  const source = cascade.replace(/\/\*[\s\S]*?\*\//gu, '')
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

/** Track lists are space-separated; parentheses keep `minmax(0, 1fr)` in one piece. */
function tracks(template: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at <= template.length; at += 1) {
    const char = template[at]
    if (at === template.length || (char !== undefined && /\s/u.test(char) && depth === 0)) {
      const token = template.slice(start, at).trim()
      if (token !== '') parts.push(token)
      start = at + 1
    } else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
  }
  return parts
}
