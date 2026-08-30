import { describe, expect, it } from 'vitest'

import {
  FeatureResourceRegistry,
  compareFeatureEventCursor,
  isCanonicalWorkspaceRelativePath,
  isFeatureEventGap,
  isFeatureEventStale,
  resourceScopeAllows,
} from '../packages/domain/src/feature-contracts.js'

describe('staged feature domain contracts', () => {
  it('accepts only canonical workspace-relative paths', () => {
    for (const value of ['src/main.ts', '.vscode/settings.json', 'folder/file name.md']) {
      expect(isCanonicalWorkspaceRelativePath(value)).toBe(true)
    }
    for (const value of [
      '',
      '/src/main.ts',
      'C:/src/main.ts',
      'file:///src/main.ts',
      '../main.ts',
      'src/../main.ts',
      'src\\main.ts',
      'src/main.ts:secret',
      'src//main.ts',
      'src/./main.ts',
      'src/\u0000main.ts',
    ]) {
      expect(isCanonicalWorkspaceRelativePath(value)).toBe(false)
    }
  })

  it('orders only events from the same backend and session stream', () => {
    const current = {
      backendInstanceId: 'backend-1',
      connectionGeneration: 2,
      stream: 'mux',
      sessionId: 'session-1',
      serverSeq: 10,
    } as const
    expect(isFeatureEventStale({ ...current, serverSeq: 9 }, current)).toBe(true)
    expect(isFeatureEventStale({ ...current }, current)).toBe(true)
    expect(isFeatureEventStale({ ...current, serverSeq: 11 }, current)).toBe(false)
    expect(isFeatureEventStale({ ...current, connectionGeneration: 1, serverSeq: 99 }, current)).toBe(true)
    expect(isFeatureEventStale({ ...current, connectionGeneration: 3, serverSeq: 0 }, current)).toBe(false)
    expect(isFeatureEventGap({ ...current, serverSeq: 12 }, current)).toBe(true)
    expect(isFeatureEventGap({ ...current, serverSeq: 11 }, current)).toBe(false)
    expect(compareFeatureEventCursor({ ...current, backendInstanceId: 'backend-2' }, current)).toBeUndefined()
    expect(compareFeatureEventCursor({ ...current, sessionId: 'session-2' }, current)).toBeUndefined()
    expect(
      compareFeatureEventCursor(
        { stream: 'host', backendInstanceId: 'backend-1', connectionGeneration: 2, localSeq: 2 },
        { stream: 'host', backendInstanceId: 'backend-1', connectionGeneration: 2, localSeq: 1 },
      ),
    ).toBe(1)
    expect(
      compareFeatureEventCursor(current, {
        stream: 'host',
        backendInstanceId: 'backend-1',
        connectionGeneration: 2,
        localSeq: 1,
      }),
    ).toBeUndefined()
    expect(isFeatureEventGap({ ...current, connectionGeneration: 3, serverSeq: 20 }, current)).toBe(false)
  })

  it('enforces owner, workspace, generation, expiry, and scoped disposal', () => {
    let now = 1_000
    const scope = {
      ownerId: 'view-1',
      workspaceFolderId: 'workspace-1',
      ownerViewId: 'view-1',
      sessionId: 'session-1',
      backendInstanceId: 'backend-1',
      connectionGeneration: 4,
      expiresAt: 2_000,
    } as const
    const expected = {
      ownerId: 'view-1',
      workspaceFolderId: 'workspace-1',
      ownerViewId: 'view-1',
      sessionId: 'session-1',
      backendInstanceId: 'backend-1',
      connectionGeneration: 4,
    } as const
    expect(resourceScopeAllows(scope, expected, now)).toBe(true)
    expect(resourceScopeAllows(scope, { ownerId: 'view-1', workspaceFolderId: 'workspace-1' }, now)).toBe(
      false,
    )
    expect(resourceScopeAllows(scope, { ...expected, connectionGeneration: 3 }, now)).toBe(false)
    expect(resourceScopeAllows(scope, { ...expected, ownerId: 'other-view' }, now)).toBe(false)

    const registry = new FeatureResourceRegistry<string>(() => now)
    expect(registry.register({ resourceId: 'context-1', value: 'safe-preview', scope })).toBe(true)
    expect(registry.register({ resourceId: 'context-1', value: 'replacement', scope })).toBe(false)
    expect(registry.get('context-1', expected)).toBe('safe-preview')
    expect(registry.get('context-1', { ownerId: 'view-1', workspaceFolderId: 'workspace-1' })).toBeUndefined()
    expect(registry.get('context-1', { ...expected, connectionGeneration: 3 })).toBeUndefined()
    expect(registry.release('context-1', { ...expected, ownerId: 'other-view' })).toBe(false)
    expect(registry.size).toBe(1)

    now = 2_000
    expect(registry.get('context-1', expected)).toBeUndefined()
    expect(registry.size).toBe(0)

    now = 1_000
    expect(registry.register({ resourceId: 'context-2', value: 'a', scope })).toBe(true)
    expect(
      registry.register({
        resourceId: 'context-3',
        value: 'b',
        scope: { ...scope, ownerId: 'view-2' },
      }),
    ).toBe(true)
    expect(registry.disposeOwned(expected)).toBe(1)
    expect(registry.size).toBe(1)
    expect(
      registry.register({ resourceId: 'expired', value: 'nope', scope: { ...scope, expiresAt: 1_000 } }),
    ).toBe(false)
    expect(
      registry.register({
        resourceId: 'too-long',
        value: 'nope',
        scope: { ...scope, expiresAt: 1_000 + 25 * 60 * 60 * 1_000 },
      }),
    ).toBe(false)
  })
})
