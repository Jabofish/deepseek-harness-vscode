import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutStyles = readFileSync(new URL('./layout.css', import.meta.url), 'utf8')
const compatibilityStyles = readFileSync(new URL('./compatibility.css', import.meta.url), 'utf8')

const WORKSPACE_RAIL = '.dsh-session-switcher__workspace--active::before,'
const SESSION_RAIL = '.dsh-session-switcher__list .dsh-session-item__button--active::before {'

describe('Session switcher accent rail layout', () => {
  it('draws one uniform rail for the workspace row and its session rows', () => {
    expect(layoutStyles).toContain(`${WORKSPACE_RAIL}\n${SESSION_RAIL}`)
    const rule = cssRule(`${WORKSPACE_RAIL}\n${SESSION_RAIL}`)
    expect(rule).toContain('position: absolute;')
    expect(rule).toContain('width: 2px;')
    expect(rule).toContain('inset-block: var(--dsh-space-1);')
    expect(rule).toContain('inset-inline-start: 0;')
    expect(rule).toContain('background: var(--dsh-accent-line);')
  })

  it('hangs the rails off the row boxes so both start at the row edge', () => {
    expect(cssRule('.dsh-session-switcher__workspace {')).toContain('position: relative;')
    expect(cssRule('.dsh-session-switcher__list .dsh-session-item__button {')).toContain(
      'position: relative;',
    )
    // A rail on the inner workspace button lands a padding step right of the
    // session rails, which is what made the two bars look misaligned.
    expect(compatibilityStyles).not.toMatch(/\.dsh-session-switcher__workspace-button[^{]*\{[^}]*box-shadow/)
  })

  it('indents session rows so the workspace row stays the widest', () => {
    expect(cssRule('.dsh-session-switcher__results .dsh-session-switcher__list > li {')).toContain(
      'padding-inline-start: var(--dsh-space-3);',
    )
  })
})

function cssRule(selector: string): string {
  const start = layoutStyles.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = layoutStyles.indexOf('{', start) + 1
  const bodyEnd = layoutStyles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return layoutStyles.slice(bodyStart, bodyEnd)
}
