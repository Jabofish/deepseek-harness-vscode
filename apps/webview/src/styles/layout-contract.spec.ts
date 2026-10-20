import { readStylesheet } from '../../../../scripts/read-stylesheet.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Layout contracts that jsdom cannot observe: real layout bugs were only
 * visible in geometry, so each surviving case here pins a rule that once
 * regressed in a shipped build (the incident is named in its case). Styles
 * without such an incident stay untested — restating declarations like
 * `display: flex;` back at the stylesheet verifies the file, not the layout.
 */

// app.css imports the compatibility sheet first, so a later app.css rule wins
// at equal specificity; reading both in cascade order answers "what applies".
const compatibilityStyles = readStylesheet(new URL('./compatibility.css', import.meta.url))
const cascade =
  compatibilityStyles +
  '\n' +
  readStylesheet(new URL('./app.css', import.meta.url), [new URL('./compatibility.css', import.meta.url)])
const layoutStyles = readStylesheet(new URL('./layout.css', import.meta.url))
const appStyles = readStylesheet(new URL('./app.css', import.meta.url), [
  new URL('./compatibility.css', import.meta.url),
])
const focusedStyles = readStylesheet(new URL('./focused-workbench.css', import.meta.url))
const selectionStyles = readStylesheet(new URL('./components/02-selection.css', import.meta.url))

describe('Conversation space ownership', () => {
  it('stacks transcript hydration notices above content so opening a session cannot halve its width', () => {
    // TimelineRow returns the pending/retrying notice and the message as
    // siblings. Horizontal flex split a real 224px startup row into two
    // 112px columns until the full-content response removed the notice.
    expect(effective(appStyles, '.dsh-timeline__row', 'flex-direction')).toBe('column')
  })

  it('keeps notifications in document flow', () => {
    const styles = `${appStyles}\n${layoutStyles}`
    for (const selector of ['.dsh-app__notices', '.dsh-app__notice-summary', '.dsh-app__notice-list']) {
      expect(ruleBodies(styles, selector).length, selector).toBeGreaterThan(0)
      expect(declared(styles, selector, 'position'), selector).not.toContain('absolute')
      expect(declared(styles, selector, 'position'), selector).not.toContain('fixed')
    }
    expect(effective(styles, '.dsh-app__notice-list', 'overflow')).toBe('auto')
    expect(effective(styles, '.dsh-conversation', 'overflow-y')).toBe('auto')
  })

  it('floats record details without reserving a row or a second tiny text scroller', () => {
    expect(effective(layoutStyles, '.dsh-trajectory-inspector', 'position')).toBe('absolute')
    expect(declared(layoutStyles, '.dsh-trajectory-inspector', 'flex')).toEqual([])
    expect(effective(layoutStyles, '.dsh-trajectory-inspector', 'overflow-y')).toBe('auto')
    expect(declared(appStyles, '.dsh-trajectory-inspector__block pre', 'max-height')).toEqual([])
    expect(declared(appStyles, '.dsh-trajectory-inspector__block pre', 'overflow')).toEqual([])
  })

  it('floats the jump control over the transcript instead of claiming a row', () => {
    const styles = `${appStyles}\n${layoutStyles}`
    // The affordance is absolutely positioned inside its shell, so showing it
    // never shrinks the scroll area; both owning shells are the positioning
    // context it anchors to.
    expect(declared(styles, '.dsh-scroll-to-latest', 'position')).toContain('absolute')
    for (const shell of ['.dsh-timeline-shell', '.dsh-trajectory-shell']) {
      expect(effective(styles, shell, 'position'), shell).toBe('relative')
    }
  })
})

describe('Conversation interaction dock', () => {
  it('lets the transcript and interaction stack shrink before short windows lose the composer', () => {
    // At 240 x 380 the old 10rem timeline floor pushed input and Stop below
    // the viewport once an approval or question occupied the tail.
    expect(effective(layoutStyles, '.dsh-timeline-shell', 'min-height')).toBe('0')
    expect(effective(appStyles, '.dsh-trajectory-shell', 'min-height')).toBe('0')
    expect(effective(layoutStyles, '.dsh-trajectory-inspector', 'min-height')).toBe('0')
    expect(declared(layoutStyles, '.dsh-trajectory-shell--inspecting', 'min-height')).toEqual([])
    expect(cssRule(layoutStyles, '.dsh-conversation__interactions')).toContain('flex: 0 1 auto;')
  })

  it('bounds the pending interaction stack above the composer without shrinking decision controls', () => {
    const interactionRule = cssRule(layoutStyles, '.dsh-conversation__interactions')
    expect(interactionRule).not.toContain('position: absolute;')
    expect(interactionRule).toContain('flex-direction: column;')
    expect(interactionRule).toContain('min-height: 0;')
    expect(interactionRule).toContain('max-height: var(--dsh-content-panel-max-height);')
    expect(interactionRule).toContain('overflow-y: auto;')

    const bodyRule = cssRule(appStyles, '.dsh-interaction__body')
    expect(bodyRule).toContain('min-height: 0;')
    expect(bodyRule).toContain('overflow-y: auto;')
    expect(bodyRule).toContain('overscroll-behavior: contain;')
    expect(cssRule(appStyles, '.dsh-interaction__header,\n.dsh-interaction__actions')).toContain(
      'flex: 0 0 auto;',
    )
  })

  it('renders the full question prompt instead of clamping the header title', () => {
    // A clamped prompt silently dropped whole inlined options: measured at a
    // 512px viewport the title needed 60px and only 40px was laid out, and
    // `scrollHeight === clientHeight` so no DOM test could see it.
    const titleRule = cssRule(appStyles, '.dsh-interaction__header h2')
    expect(titleRule).not.toContain('-webkit-line-clamp')
    expect(titleRule).not.toContain('overflow: hidden;')
    expect(titleRule).toContain('overflow-wrap: anywhere;')
  })
})

describe('Session switcher accent rail', () => {
  it('draws one shared rail hung off the row boxes', () => {
    const workspaceRail = '.dsh-session-switcher__workspace--active::before,'
    const sessionRail = '.dsh-session-switcher__list .dsh-session-item__button--active::before {'
    const rule = cssRuleAt(layoutStyles, `${workspaceRail}\n${sessionRail}`)
    expect(rule).toContain('position: absolute;')
    expect(rule).toContain('width: 2px;')
    expect(rule).toContain('background: var(--dsh-accent-line);')

    expect(cssRule(layoutStyles, '.dsh-session-switcher__workspace')).toContain('position: relative;')
    expect(cssRule(layoutStyles, '.dsh-session-switcher__list .dsh-session-item__button')).toContain(
      'position: relative;',
    )
    // A rail on the inner workspace button lands a padding step right of the
    // session rails, which is what made the two bars look misaligned.
    expect(cascade).not.toMatch(/\.dsh-session-switcher__workspace-button[^{]*\{[^}]*box-shadow/)
  })
})

describe('Form control base styles', () => {
  it('covers the native dropdown in every shared control rule', () => {
    // A native `<select>` is the one form control the browser gives platform chrome
    // of its own, so every shared control rule has to name it even though the
    // Webview renders choices through the themed SelectMenu.
    expect(cssRuleBodies(appStyles, 'button,\ninput,\ntextarea,\nselect').join('\n')).toContain(
      'font: inherit;',
    )
    expect(cssRuleBodies(appStyles, 'input,\ntextarea,\nselect').join('\n')).toContain(
      'min-height: var(--dsh-control-height);',
    )
    expect(
      cssRuleBodies(
        appStyles,
        'input:focus-visible,\ntextarea:focus-visible,\nselect:focus-visible,\nbutton:focus-visible,\nsummary:focus-visible',
      ).join('\n'),
    ).toContain('outline: 1px solid var(--dsh-focus-ring);')
  })
})

describe('Readable session choices', () => {
  it('gives enabled and disabled selectors distinct text in both layouts', () => {
    expect(effective(selectionStyles, '.dsh-select-menu__trigger', 'color')).toBe('var(--dsh-text)')
    expect(effective(selectionStyles, '.dsh-select-menu__trigger:disabled', 'color')).toBe('var(--dsh-muted)')
  })

  it('removes compatibility rules that turn labelled choices into 28px icons', () => {
    for (const selector of [
      '.dsh-select-menu--labelled',
      '.dsh-session-controls__mode',
      '.dsh-model-picker',
      '.dsh-session-controls__selectors > .dsh-select-menu',
      '.dsh-session-controls__selectors > .dsh-session-controls__mode',
    ]) {
      for (const body of ruleBodies(compatibilityStyles, selector)) {
        expect(declaration(body, 'width')).toBeUndefined()
        expect(declaration(body, 'max-width')).toBeUndefined()
        expect(declaration(body, 'flex')).toBeUndefined()
      }
    }
  })

  it('reserves a full-width choices rail before text competes with Send', () => {
    expect(
      effective(
        layoutStyles,
        '.dsh-app .dsh-unified-composer .dsh-composer__toolbar:has(.dsh-session-controls__mode)',
        'grid-template-areas',
      ),
    ).toBe("'controls controls' 'start submit'")
    expect(focusedStyles).not.toContain("'start start' 'controls submit'")
  })

  it('does not stack context under the model inside a compressed middle toolbar cell', () => {
    // At 507 x 142 CSS px (634 x 178 at 125% scale), wrapping this cell
    // alone put the model above the permission/Send baseline and context below.
    const selector = '.dsh-app .dsh-unified-composer .dsh-composer__toolbar-controls > .dsh-session-controls'
    expect(declaration(ruleBodies(layoutStyles, selector)[0] ?? '', 'flex-wrap')).toBe('nowrap')
    expect(
      declaration(
        ruleBodies(
          layoutStyles,
          '.dsh-unified-composer .dsh-composer__toolbar-controls .dsh-session-controls__selectors',
        )[0] ?? '',
        'flex-wrap',
      ),
    ).toBe('nowrap')
    expect(layoutStyles).toMatch(/@container dsh-composer \(max-width: [\d.]+em\)/u)
    const compactRail = layoutStyles.slice(layoutStyles.indexOf('@container dsh-composer'))
    expect(effective(compactRail, selector, 'flex-wrap')).toBe('wrap')
    expect(
      effective(
        compactRail,
        '.dsh-app .dsh-unified-composer .dsh-composer__toolbar:has(.dsh-session-controls)',
        'grid-template-areas',
      ),
    ).toBe("'controls controls' 'start submit'")
  })

  it('keeps ordinary sidebars on one row before using the narrow choices rail', () => {
    // The 40em/52em cutoffs forced even the reported 566px view onto two rows.
    // Compact spacing and on-demand context details should be used first.
    const containers = [
      ...layoutStyles.matchAll(
        /@container dsh-composer \(([^)]+)\)(?: or \(([^)]+)\))? \{([\s\S]*?)(?=\n@(?:container|media)|$)/gu,
      ),
    ]
    const reflow = containers.filter(([, , , body]) => body?.includes("'controls controls' 'start submit'"))
    expect(reflow.length).toBeGreaterThan(0)
    for (const [, scaled, minimum] of reflow) {
      expect(scaled).toMatch(/^max-width: [\d.]+em$/u)
      expect(Number.parseFloat(scaled?.split(':')[1] ?? '')).toBeLessThanOrEqual(22)
      // Icons keep their own minimum size even when message text is smaller.
      expect(minimum).toMatch(/^max-width: [\d.]+rem$/u)
      expect(Number.parseFloat(minimum?.split(':')[1] ?? '')).toBeLessThanOrEqual(20)
    }
  })

  it('keeps the attachment rail stable while a batch arrives', () => {
    const wrapping = declared(layoutStyles, '.dsh-unified-composer .dsh-composer__attachments', 'flex-wrap')
    expect(wrapping.length).toBeGreaterThan(0)
    // Narrow multi-row attachments made the transcript jump again for every
    // asynchronously ingested file. Paging must keep all files reachable.
    for (const value of wrapping) expect(value).toBe('nowrap')
  })
})

describe('Configured model editor layout', () => {
  // The configured-model card regressed once: a leftover five-track template on
  // the card squeezed the row into its first track, so the id and name inputs
  // rendered as ~40px chips with the rest of the row empty. A stale copy of the
  // same template also hid inside a `@media` block, so these cases read every
  // rule of the sheet — grouped selectors and media-scoped ones included.
  it('keeps every model card on a single track', () => {
    const templates = ruleBodies(compatibilityStyles, '.dsh-settings__editable-model')
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
      expect(effective(compatibilityStyles, selector, 'grid-column')).toBe('1')
      expect(effective(compatibilityStyles, selector, 'width')).toBe('100%')
      expect(effective(compatibilityStyles, selector, 'box-sizing')).toBe('border-box')
    }
  })

  it('splits the row between the two fractional input columns', () => {
    const templates = ruleBodies(compatibilityStyles, '.dsh-settings__editable-model-row')
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
      expect(effective(compatibilityStyles, selector, 'display')).toBe('flex')
      expect(effective(compatibilityStyles, selector, 'flex-wrap')).toBe('wrap')
    }
  })
})

describe('Provider card layout', () => {
  // The provider card once shared one wrapping flex row with its buttons, so a long
  // provider id pushed the edit/remove cluster onto a line of its own and left half
  // the card empty. The head is a two-column grid now: the identity chips wrap in
  // the first column and the buttons hold the end of the first row.
  it('pins the action cluster to the end of the first row', () => {
    // No group rule may turn the head back into a flex row.
    for (const value of declared(cascade, '.dsh-settings__provider-head', 'display')) {
      expect(value).toBe('grid')
    }

    const template = effective(cascade, '.dsh-settings__provider-head', 'grid-template-columns')
    expect(template).toBeDefined()
    const columns = tracks(template ?? '')
    expect(columns).toHaveLength(2)
    expect(columns[0]).toMatch(/[\d.]+fr/u)
    expect(columns[1]).toBe('auto')
    expect(effective(cascade, '.dsh-settings__provider-actions', 'justify-content')).toBe('flex-end')
  })

  it('lets the identity chips wrap inside their column', () => {
    expect(effective(cascade, '.dsh-settings__provider-identity', 'display')).toBe('flex')
    expect(effective(cascade, '.dsh-settings__provider-identity', 'flex-wrap')).toBe('wrap')
    expect(effective(cascade, '.dsh-settings__provider-identity', 'min-width')).toBe('0')
  })

  it('keeps the model count and the credential controls on one wrapping row', () => {
    // The summary used to be a grid track of the card, which stacked the count
    // above the credential controls.
    for (const value of declared(cascade, '.dsh-settings__provider-summary', 'display')) {
      expect(value).toBe('flex')
    }

    expect(effective(cascade, '.dsh-settings__provider-summary', 'flex-wrap')).toBe('wrap')
    expect(effective(cascade, '.dsh-settings__provider-summary', 'min-width')).toBe('0')
  })

  it('keeps the provider id quiet next to the name it repeats', () => {
    expect(effective(cascade, '.dsh-settings__provider-identity code', 'color')).toBe('var(--dsh-muted)')
    // The id used to be a literal em size; it is a scale token now, so the
    // assertion resolves the step instead of reading a number off the declaration.
    const size = effective(cascade, '.dsh-settings__provider-identity code', 'font-size') ?? ''
    expect(resolveFontSize(size)).toBeLessThan(BODY_FONT_SIZE_PX)
    expect(effective(cascade, '.dsh-settings__provider-identity code', 'text-overflow')).toBe('ellipsis')
  })
})

// 13px is the webview body default; a caption shorter than it cannot compete with
// the provider name beside it.
const BODY_FONT_SIZE_PX = 13

const steps = new Map(
  [...tokensSource().matchAll(/(--dsh-font-size-[a-z0-9]+):\s*([\d.]+)rem/gu)].map(([, name, rem]) => [
    name ?? '',
    Number.parseFloat(rem ?? '') * 16,
  ]),
)

function tokensSource(): string {
  return readFileSync(
    fileURLToPath(new URL('../../../../packages/ui/src/styles.css', import.meta.url)),
    'utf8',
  )
}

function resolveFontSize(value: string): number {
  const token = /^var\((--dsh-font-size-[a-z0-9]+)\)$/u.exec(value.trim())
  expect(token, `Resolve font-size "${value}" from the type scale`).not.toBeNull()
  const px = steps.get(token?.[1] ?? '')
  expect(px, `Scale token ${token?.[1]} declares a rem size`).toBeDefined()
  return px ?? Number.POSITIVE_INFINITY
}

/** Body of the first rule whose selector text matches exactly, braces included. */
function cssRule(styles: string, selector: string): string {
  return cssRuleAt(styles, `${selector} {`)
}

/** Same as `cssRule` for a pre-joined selector string that already ends in `{`. */
function cssRuleAt(styles: string, selectorWithBrace: string): string {
  const start = styles.indexOf(selectorWithBrace)
  expect(start).toBeGreaterThanOrEqual(0)
  if (start < 0) return ''

  const bodyStart = start + selectorWithBrace.length
  const bodyEnd = styles.indexOf('}', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return styles.slice(bodyStart, bodyEnd)
}

/** Every rule body whose selector list contains `selector`, repeated rules included. */
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
  expect(bodies.length).toBeGreaterThan(0)
  return bodies
}

/** Every declared value in the cascade, grouped selectors included. */
function declared(styles: string, selector: string, property: string): readonly string[] {
  return ruleBodies(styles, selector)
    .map((body) => declaration(body, property))
    .filter((value): value is string => value !== undefined)
}

/** Declarations seen last in the cascade win, so the last body that names a property carries it. */
function effective(styles: string, selector: string, property: string): string | undefined {
  let value: string | undefined
  for (const body of ruleBodies(styles, selector)) {
    const found = declaration(body, property)
    if (found !== undefined) value = found
  }
  return value
}

function ruleBodies(styles: string, selector: string): readonly string[] {
  const source = styles.replace(/\/\*[\s\S]*?\*\//gu, '')
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
