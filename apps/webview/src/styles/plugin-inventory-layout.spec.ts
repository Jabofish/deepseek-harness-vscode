import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('Plugin inventory detail layout', () => {
  it('keeps fact labels and values in compact rows', () => {
    const detailsRule = cssRule('.dsh-plugin-inventory__details')
    expect(detailsRule).toContain('display: grid;')
    expect(detailsRule).toContain('grid-template-columns: max-content minmax(0, 1fr);')
    expect(detailsRule).toContain('margin: 0;')
    expect(cssRule('.dsh-plugin-inventory__details > div')).toContain('display: contents;')
    expect(cssRule('.dsh-plugin-inventory__details dd')).toContain('margin: 0;')
  })
})

function cssRule(selector: string): string {
  const marker = `\n\n${selector} {`
  const start = appStyles.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = start + marker.length
  const bodyEnd = appStyles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return appStyles.slice(bodyStart, bodyEnd)
}
