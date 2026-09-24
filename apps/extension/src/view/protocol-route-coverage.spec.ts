import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { featureRequestSchema, webviewRequestSchema } from '@dsh-vscode/webview-protocol'

/**
 * The two request unions are the Webview's contract, and an entry without a
 * dispatching branch is worse than a missing one: the envelope parses, the
 * request travels, and the only possible answer is an error the client cannot
 * act on. A stale entry was already found once (`changes.restore.prepare` had
 * no branch anywhere), so coverage is pinned against the composition root.
 */
const COMPOSITION_ROOT = readFileSync(new URL('../composition-root.ts', import.meta.url), 'utf8')

/** The router answers `feature.request.cancel` itself, before the feature handler. */
const ROUTER_INTERCEPTED = new Set(['feature.request.cancel'])

/** The declared request types of a discriminated union, read off the schema itself. */
function declaredTypes(schema: unknown): readonly string[] {
  const options = (schema as { options: readonly { shape: Record<string, { value?: unknown }> }[] }).options
  return options.map((option) =>
    typeof option.shape.type?.value === 'string' ? option.shape.type.value : '',
  )
}

function handlerBody(startMarker: string, endMarker: string): string {
  const start = COMPOSITION_ROOT.indexOf(startMarker)
  expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0)
  const end = COMPOSITION_ROOT.indexOf(endMarker, start)
  expect(end, `missing ${endMarker} after ${startMarker}`).toBeGreaterThan(start)
  return COMPOSITION_ROOT.slice(start, end)
}

function routedTypes(body: string): ReadonlySet<string> {
  return new Set([...body.matchAll(/request\.type === '([^']+)'/gu)].map((match) => match[1] ?? ''))
}

const handleFeatureRequestBody = handlerBody(
  'const handleFeatureRequest = ',
  'const handleRequest = async (request: WebviewRequest',
)
const handleRequestBody = handlerBody(
  'const handleRequest = async (request: WebviewRequest',
  'const router = new WebviewMessageRouter({',
)
const sessionHistoryRequestBody = handlerBody(
  "if (request.type === 'session.history') {",
  "if (request.type === 'session.create') {",
)
const jobFollowStartBody = handlerBody('const startJobFollow = ', 'const requireCurrentWorkspaceId = ')

describe('feature route coverage', () => {
  it('dispatches every declared feature request', () => {
    const routed = routedTypes(handleFeatureRequestBody)
    const missing = declaredTypes(featureRequestSchema).filter(
      (type) => !ROUTER_INTERCEPTED.has(type) && !routed.has(type),
    )
    expect(missing).toEqual([])
  })

  it('declares every feature request it dispatches', () => {
    const declared = new Set(declaredTypes(featureRequestSchema))
    const undeclared = [...routedTypes(handleFeatureRequestBody)].filter((type) => !declared.has(type))
    expect(undeclared).toEqual([])
  })

  it('refuses an undispatchable feature request instead of reporting success', () => {
    expect(handleFeatureRequestBody).not.toMatch(/return \{\s*accepted: true\s*\}/u)
    expect(handleFeatureRequestBody).toMatch(/code: 'FEATURE_DISABLED'/u)
  })
})

describe('webview route coverage', () => {
  it('validates job follow cursors without comparing them to a stale list snapshot', () => {
    expect(jobFollowStartBody).toContain('resolveJobFollowOffset(job, requestedFrom)')
  })

  it('forwards explicit session history purpose without forcing turn alignment', () => {
    expect(sessionHistoryRequestBody).toContain('request.payload.pagePurpose')
    expect(sessionHistoryRequestBody).not.toMatch(/turnAligned\s*:\s*true/u)
  })

  it('dispatches every declared request', () => {
    const routed = routedTypes(handleRequestBody)
    const missing = declaredTypes(webviewRequestSchema).filter((type) => !routed.has(type))
    expect(missing).toEqual([])
  })

  it('declares every request it dispatches', () => {
    const declared = new Set(declaredTypes(webviewRequestSchema))
    const undeclared = [...routedTypes(handleRequestBody)].filter((type) => !declared.has(type))
    expect(undeclared).toEqual([])
  })

  it('refuses an undispatchable request instead of reporting success', () => {
    expect(handleRequestBody).not.toMatch(/return \{\s*accepted: true\s*\}/u)
    expect(handleRequestBody).toMatch(/code: 'FEATURE_DISABLED'/u)
  })
})
