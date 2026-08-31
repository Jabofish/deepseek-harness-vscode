import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const componentStyles = readFileSync(new URL('./components.css', import.meta.url), 'utf8')

describe('Markdown table layout', () => {
  it('keeps wide-table scrollbar geometry stable while revealing its thumb', () => {
    const wideTableRule = cssRule('.dsh-markdown__table-scroll')
    const interactionRule = cssRule(
      '.dsh-markdown__table-scroll:hover,\n.dsh-markdown__table-scroll:focus-visible',
    )

    expect(cssRule('.dsh-markdown__copy-region--table-wide')).toContain('overflow: visible;')
    expect(wideTableRule).toContain('overflow-x: auto;')
    expect(wideTableRule).toContain('scrollbar-gutter: stable;')
    expect(wideTableRule).toContain('scrollbar-color: transparent transparent;')
    expect(interactionRule).toContain('scrollbar-color: var(--dsh-muted) transparent;')
    expect(interactionRule).not.toMatch(/overflow|padding/u)
    expect(componentStyles).toContain('.dsh-markdown__table-scroll:hover::-webkit-scrollbar-thumb')
  })
})

function cssRule(selector: string): string {
  const start = componentStyles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = start + selector.length + 2
  const bodyEnd = componentStyles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return componentStyles.slice(bodyStart, bodyEnd)
}
