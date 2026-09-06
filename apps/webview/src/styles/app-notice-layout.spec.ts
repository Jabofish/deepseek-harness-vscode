import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('Application notice layout', () => {
  it('keeps the runtime update notice in a viewport overlay', () => {
    const rule = cssRule('.dsh-app__runtime-update')
    expect(rule).toContain('position: fixed;')
    expect(rule).toContain('inset-block-start: var(--dsh-space-4);')
    expect(rule).toContain('inset-inline-end: var(--dsh-space-4);')
    expect(rule).toContain('z-index: 60;')
    expect(rule).toContain('box-shadow: var(--dsh-shadow);')
  })
})

function cssRule(selector: string): string {
  const start = appStyles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = start + selector.length + 2
  const bodyEnd = appStyles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return appStyles.slice(bodyStart, bodyEnd)
}
