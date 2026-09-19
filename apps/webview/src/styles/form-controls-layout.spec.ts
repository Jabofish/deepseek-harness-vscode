import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const compatibilityStyles = readFileSync(new URL('./compatibility.css', import.meta.url), 'utf8')

// A native `<select>` is the one form control the browser gives platform chrome
// of its own, so every shared control rule has to name it. The plugin
// configuration is where the Webview renders one (enum and boolean fields).
describe('Form control base styles', () => {
  it('covers the native dropdown in every shared control rule', () => {
    expect(cssRuleBodies(appStyles, 'button,\ninput,\ntextarea,\nselect').join('\n')).toContain(
      'font: inherit;',
    )
    const controls = cssRuleBodies(appStyles, 'input,\ntextarea,\nselect').join('\n')
    expect(controls).toContain('min-height: var(--dsh-control-height);')
    expect(controls).toContain('background: var(--dsh-input-bg);')
    expect(controls).toContain('padding: var(--dsh-space-2) var(--dsh-space-3);')
    expect(
      cssRuleBodies(
        appStyles,
        'input:focus-visible,\ntextarea:focus-visible,\nselect:focus-visible,\nbutton:focus-visible,\nsummary:focus-visible',
      ).join('\n'),
    ).toContain('outline: 1px solid var(--dsh-focus-ring);')
  })

  it('sizes the plugin configuration dropdown with the field it belongs to', () => {
    const rule = cssRule(
      compatibilityStyles,
      '.dsh-plugin-configuration__field input,\n.dsh-plugin-configuration__field select',
    )
    expect(rule).toContain('width: 100%;')
    expect(rule).toContain('box-sizing: border-box;')
  })
})

function cssRule(styles: string, selector: string): string {
  const bodies = cssRuleBodies(styles, selector)
  expect(bodies.length).toBeGreaterThan(0)
  return bodies[0] ?? ''
}

function cssRuleBodies(styles: string, selector: string): readonly string[] {
  const marker = `\n\n${selector} {`
  const bodies: string[] = []
  let start = styles.indexOf(marker)
  while (start >= 0) {
    const bodyStart = start + marker.length
    const bodyEnd = styles.indexOf('}', bodyStart)
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    bodies.push(styles.slice(bodyStart, bodyEnd))
    start = styles.indexOf(marker, bodyEnd)
  }
  return bodies
}
