import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutStyles = readFileSync(new URL('./layout.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('Conversation interaction layout', () => {
  it('docks pending interactions in the composer slot with a bounded height', () => {
    const interactionRule = cssRule(layoutStyles, '.dsh-conversation__interactions')
    expect(interactionRule).not.toContain('position: absolute;')
    expect(interactionRule).toContain('flex: 0 1 auto;')
    expect(interactionRule).toContain('flex-direction: column;')
    expect(interactionRule).toContain('min-height: 0;')
    expect(interactionRule).toContain('max-height: min(70vh, 42rem, calc(100% - 12rem));')
    expect(interactionRule).toContain('overflow: hidden;')
  })

  it('gives each pending card a column that can shrink inside the dock', () => {
    const cardRule = cssRule(layoutStyles, '.dsh-conversation__interactions > .dsh-interaction')
    expect(cardRule).toContain('display: flex;')
    expect(cardRule).toContain('flex-direction: column;')
    expect(cardRule).toContain('min-height: 0;')
  })

  it('scrolls the question body so the card actions stay visible', () => {
    const bodyRule = cssRule(appStyles, '.dsh-interaction__body')
    expect(bodyRule).toContain('flex: 1 1 auto;')
    expect(bodyRule).toContain('min-height: 0;')
    expect(bodyRule).toContain('overflow-y: auto;')
    expect(bodyRule).toContain('overscroll-behavior: contain;')

    const fixedRule = cssRule(appStyles, '.dsh-interaction__header,\n.dsh-interaction__actions')
    expect(fixedRule).toContain('flex: 0 0 auto;')
  })

  it('keeps nested picker menus outside the extras scrollport', () => {
    const extrasRule = cssRule(layoutStyles, '.dsh-composer__extras-panel')
    expect(extrasRule).toContain(
      'animation: dsh-overlay-fade-in var(--dsh-motion-duration-standard) var(--dsh-motion-ease-enter) both;',
    )
    expect(extrasRule).toContain('overflow-y: auto;')
  })
})

function cssRule(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = start + selector.length + 2
  const bodyEnd = styles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return styles.slice(bodyStart, bodyEnd)
}
