/**
 * Host-owned contracts shared by the next-generation editor, review, task,
 * and recovery surfaces.
 *
 * This file deliberately contains no VS Code, Node, HTTP, or DSH wire types.
 * It describes the identity and lifetime rules that an adapter/application
 * implementation must enforce before a value crosses into a Webview.
 */

export const FEATURE_CAPABILITY_IDS = [
  'ED-01',
  'RV-01',
  'TC-01',
  'CP-01',
  'PT-01',
  'NAV-01',
  'SY-01',
  'RF-01',
] as const

export type FeatureCapabilityId = (typeof FEATURE_CAPABILITY_IDS)[number]

export type FeatureCapabilityState = 'verified-contract' | 'compatibility-fallback' | 'unavailable'

export interface FeatureCapability {
  /** Runtime route state exposed to the application/UI. */
  readonly state: FeatureCapabilityState
  /** Upstream prerequisite evidence; this is not a claim that the route exists. */
  readonly upstream: 'verified-contract' | 'compatibility-fallback' | 'unavailable'
  readonly reason?: string
}

/**
 * This profile separates upstream prerequisite evidence from local route
 * availability. A route may have a verified upstream prerequisite while
 * remaining unavailable until its Host/Application implementation exists.
 * The capability matrix remains the source of truth for code/test/live
 * evidence levels.
 */
export interface FeatureCapabilityProfile {
  readonly dshVersion: string
  readonly protocolVersion: string
  readonly source: 'pinned-adapter' | 'compatibility-fallback'
  readonly capabilities: Readonly<Record<FeatureCapabilityId, FeatureCapability>>
}

export type FeatureEventStream = 'mux' | 'host' | 'local'

interface FeatureEventIdentityBase {
  readonly backendInstanceId: string
  readonly connectionGeneration: number
  readonly eventId?: string
  readonly rpcId?: string
  readonly toolCallId?: string
}

export type FeatureEventIdentity =
  | (FeatureEventIdentityBase & {
      readonly stream: 'mux'
      readonly sessionId: string
      readonly serverSeq: number
    })
  | (FeatureEventIdentityBase & {
      readonly stream: 'host' | 'local'
      readonly sessionId?: string
      /** Host/local streams have their own sequence space; no DSH seq is forged. */
      readonly localSeq: number
    })

export type FeatureEventCursor =
  | {
      readonly stream: 'mux'
      readonly backendInstanceId: string
      readonly connectionGeneration: number
      readonly sessionId: string
      readonly serverSeq: number
    }
  | {
      readonly stream: 'host' | 'local'
      readonly backendInstanceId: string
      readonly connectionGeneration: number
      readonly sessionId?: string
      readonly localSeq: number
    }

export interface FeatureResourceScope {
  readonly ownerId: string
  readonly workspaceFolderId: string
  readonly ownerViewId?: string
  readonly sessionId?: string
  readonly backendInstanceId?: string
  readonly connectionGeneration?: number
  readonly expiresAt: number
}

export type FeatureResourceAccess = Pick<FeatureResourceScope, 'ownerId' | 'workspaceFolderId'> &
  Partial<
    Pick<FeatureResourceScope, 'ownerViewId' | 'sessionId' | 'backendInstanceId' | 'connectionGeneration'>
  >

/**
 * Workspace-relative paths are the only file identity accepted by the future
 * feature protocol. URI schemes, drive roots, separators from another OS,
 * traversal segments, control characters, and empty segments are rejected.
 */
export function isCanonicalWorkspaceRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false
  // A colon is not valid in a portable workspace-relative file name. Reject
  // it anywhere, not only at the beginning, so Windows alternate data
  // streams such as `file.ts:secret` cannot cross the feature boundary.
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || /^[A-Za-z]:/u.test(value))
    return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false
  if (containsControlCharacters(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function sameFeatureEventStream(left: FeatureEventCursor, right: FeatureEventCursor): boolean {
  return (
    left.stream === right.stream &&
    left.backendInstanceId === right.backendInstanceId &&
    left.sessionId === right.sessionId
  )
}

function featureEventSequence(cursor: FeatureEventCursor): number {
  return cursor.stream === 'mux' ? cursor.serverSeq : cursor.localSeq
}

/**
 * Compare two cursors from one event stream. `undefined` means that the
 * cursors belong to different backend/session streams and must not be
 * ordered against each other.
 */
export function compareFeatureEventCursor(
  left: FeatureEventCursor,
  right: FeatureEventCursor,
): -1 | 0 | 1 | undefined {
  if (!sameFeatureEventStream(left, right)) return undefined
  if (left.connectionGeneration < right.connectionGeneration) return -1
  if (left.connectionGeneration > right.connectionGeneration) return 1
  const leftSequence = featureEventSequence(left)
  const rightSequence = featureEventSequence(right)
  if (leftSequence < rightSequence) return -1
  if (leftSequence > rightSequence) return 1
  return 0
}

/** A duplicate or older event in the same connection/session stream. */
export function isFeatureEventStale(candidate: FeatureEventCursor, current: FeatureEventCursor): boolean {
  const order = compareFeatureEventCursor(candidate, current)
  return order !== undefined && order <= 0
}

/** A forward gap in one physical stream that must be filled before reducing. */
export function isFeatureEventGap(candidate: FeatureEventCursor, current: FeatureEventCursor): boolean {
  if (
    !sameFeatureEventStream(candidate, current) ||
    candidate.connectionGeneration !== current.connectionGeneration
  )
    return false
  return featureEventSequence(candidate) > featureEventSequence(current) + 1
}

export const FEATURE_RESOURCE_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000

export function resourceScopeAllows(
  scope: FeatureResourceScope,
  expected: FeatureResourceAccess,
  now = Date.now(),
): boolean {
  if (!isValidResourceScope(scope, now) || scope.expiresAt <= now) return false
  if (!isNonEmpty(expected.ownerId) || !isNonEmpty(expected.workspaceFolderId)) return false
  if (scope.ownerId !== expected.ownerId || scope.workspaceFolderId !== expected.workspaceFolderId)
    return false
  return (
    // Access is exact for every binding present on the resource; omitting a
    // session, backend, view, or generation is never a wildcard here.
    scope.ownerViewId === expected.ownerViewId &&
    scope.sessionId === expected.sessionId &&
    scope.backendInstanceId === expected.backendInstanceId &&
    scope.connectionGeneration === expected.connectionGeneration
  )
}

export interface FeatureResourceEntry<T> {
  readonly resourceId: string
  readonly value: T
  readonly scope: FeatureResourceScope
}

/**
 * A small platform-neutral registry for Host-owned opaque resources. It is
 * intentionally stricter than a cache: mismatched owners/generations cannot
 * read or release an entry. `disposeOwned` is a teardown operation: omitted
 * optional bindings deliberately dispose every resource of the same owner and
 * workspace across generations, sessions, and views; it is never a read or
 * release authorization wildcard.
 */
export class FeatureResourceRegistry<T> {
  private readonly entries = new Map<string, FeatureResourceEntry<T>>()

  public constructor(private readonly now: () => number = () => Date.now()) {}

  public register(entry: FeatureResourceEntry<T>): boolean {
    const now = this.now()
    this.purgeExpired()
    if (
      !isNonEmpty(entry.resourceId) ||
      !isValidResourceScope(entry.scope, now) ||
      entry.scope.expiresAt <= now
    )
      return false
    if (this.entries.has(entry.resourceId)) return false
    this.entries.set(entry.resourceId, entry)
    return true
  }

  public get(resourceId: string, expected: FeatureResourceAccess): T | undefined {
    const entry = this.entries.get(resourceId)
    if (entry === undefined) return undefined
    const now = this.now()
    if (!resourceScopeAllows(entry.scope, expected, now)) {
      if (!isValidResourceScope(entry.scope, now) || entry.scope.expiresAt <= now)
        this.entries.delete(resourceId)
      return undefined
    }
    return entry.value
  }

  public release(resourceId: string, expected: FeatureResourceAccess): boolean {
    const entry = this.entries.get(resourceId)
    if (entry === undefined || !resourceScopeAllows(entry.scope, expected, this.now())) return false
    this.entries.delete(resourceId)
    return true
  }

  public disposeOwned(expected: FeatureResourceAccess): number {
    let disposed = 0
    for (const [resourceId, entry] of this.entries) {
      if (resourceIdentityAllows(entry.scope, expected)) {
        this.entries.delete(resourceId)
        disposed += 1
      }
    }
    return disposed
  }

  public clear(): void {
    this.entries.clear()
  }

  public get size(): number {
    return this.entries.size
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [resourceId, entry] of this.entries) {
      if (!isValidResourceScope(entry.scope, now) || entry.scope.expiresAt <= now)
        this.entries.delete(resourceId)
    }
  }
}

function isNonEmpty(value: string): boolean {
  return value.length > 0 && value.length <= 256
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isValidResourceScope(scope: FeatureResourceScope, now?: number): boolean {
  const lifetimeIsBounded =
    now === undefined || (Number.isFinite(now) && scope.expiresAt - now <= FEATURE_RESOURCE_MAX_LIFETIME_MS)
  return (
    isNonEmpty(scope.ownerId) &&
    isNonEmpty(scope.workspaceFolderId) &&
    (scope.ownerViewId === undefined || isNonEmpty(scope.ownerViewId)) &&
    (scope.sessionId === undefined || isNonEmpty(scope.sessionId)) &&
    (scope.backendInstanceId === undefined || isNonEmpty(scope.backendInstanceId)) &&
    (scope.connectionGeneration === undefined ||
      (Number.isSafeInteger(scope.connectionGeneration) && scope.connectionGeneration >= 0)) &&
    Number.isSafeInteger(scope.expiresAt) &&
    scope.expiresAt > 0 &&
    lifetimeIsBounded
  )
}

function resourceIdentityAllows(scope: FeatureResourceScope, expected: FeatureResourceAccess): boolean {
  if (
    !isValidResourceScope(scope) ||
    !isNonEmpty(expected.ownerId) ||
    !isNonEmpty(expected.workspaceFolderId)
  )
    return false
  return (
    scope.ownerId === expected.ownerId &&
    scope.workspaceFolderId === expected.workspaceFolderId &&
    (expected.ownerViewId === undefined || scope.ownerViewId === expected.ownerViewId) &&
    (expected.sessionId === undefined || scope.sessionId === expected.sessionId) &&
    (expected.backendInstanceId === undefined || scope.backendInstanceId === expected.backendInstanceId) &&
    (expected.connectionGeneration === undefined ||
      scope.connectionGeneration === expected.connectionGeneration)
  )
}
