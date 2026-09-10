import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutStyles = readFileSync(new URL('./layout.css', import.meta.url), 'utf8')

describe('Conversation interaction layout', () => {
  it('keeps pending interactions in a bounded top overlay', () => {
    expect(cssRule('.dsh-conversation')).toContain('position: relative;')

    const interactionRule = cssRule('.dsh-conversation__interactions')
    expect(interactionRule).toContain('position: absolute;')
    expect(interactionRule).toContain('inset-block-start: calc(2.25rem + var(--dsh-space-2));')
    expect(interactionRule).toContain('max-height: min(70vh, 42rem);')
    expect(interactionRule).toContain('overflow-y: auto;')
    expect(interactionRule).toContain('overscroll-behavior: contain;')
  })

  it('keeps nested picker menus outside the extras scrollport', () => {
    const extrasRule = cssRule('.dsh-composer__extras-panel')
    expect(extrasRule).toContain(
      'animation: dsh-overlay-fade-in var(--dsh-motion-duration-standard) var(--dsh-motion-ease-enter) both;',
    )
    expect(extrasRule).toContain('overflow-y: auto;')
  })
})

function cssRule(selector: string): string {
  const start = layoutStyles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = start + selector.length + 2
  const bodyEnd = layoutStyles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return layoutStyles.slice(bodyStart, bodyEnd)
}
