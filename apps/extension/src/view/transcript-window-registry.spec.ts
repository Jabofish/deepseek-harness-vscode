import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { TranscriptWindowService } from './transcript-window.js'
import { TranscriptWindowRegistry } from './transcript-window-registry.js'

afterEach(() => vi.useRealTimers())

function completed(sessionId: string, sequence: number): BackendEvent {
  return {
    type: 'message.completed',
    sessionId,
    sequence,
    messageId: `m-${sequence}`,
    markdown: `Answer ${sequence}`,
  }
}

function harness(): { registry: TranscriptWindowRegistry; sent: Map<string, TranscriptWindow[]> } {
  const sent = new Map<string, TranscriptWindow[]>()
  const registry = new TranscriptWindowRegistry((surfaceId) => {
    sent.set(surfaceId, [])
    return new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (window) => {
        sent.get(surfaceId)?.push(window)
        return Promise.resolve(true)
      },
    })
  })
  return { registry, sent }
}

describe('surface-owned transcript windows', () => {
  it('releases a failed in-flight post on close and gives a recreated panel its own recovery budget', async () => {
    let release!: (delivered: boolean) => void
    const report = vi.fn()
    let created = 0
    const post = vi.fn(() => Promise.resolve(true))
    const registry = new TranscriptWindowRegistry(
      () =>
        new TranscriptWindowService({
          read: () => Promise.resolve({ events: [], hasMore: false }),
          publicValue: (value) => value,
          post:
            created++ === 0
              ? () =>
                  new Promise((resolve) => {
                    release = resolve
                  })
              : post,
          report,
        }),
    )
    const original = registry.forSurface('editor')
    original.installPage('s1', { events: [], hasMore: false }, original.begin('s1'))
    registry.accept(completed('s1', 1))
    registry.remove('editor')
    const replacement = registry.forSurface('editor')
    replacement.installPage('s1', { events: [], hasMore: false }, replacement.begin('s1'))
    registry.accept(completed('s1', 2))
    release(false)
    for (let index = 0; index < 6; index++) await Promise.resolve()
    expect(report).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
    registry.dispose()
  })
  it('invalidates queued sends when a closed surface is recreated with the same identity', () => {
    const guards: (() => boolean)[] = []
    const registry = new TranscriptWindowRegistry((_surfaceId, isCurrent) => {
      guards.push(isCurrent)
      return new TranscriptWindowService({
        read: () => Promise.resolve({ events: [], hasMore: false }),
        publicValue: (value) => value,
        post: () => Promise.resolve(true),
      })
    })
    const original = registry.forSurface('editor')
    expect(guards[0]?.()).toBe(true)
    registry.remove('editor')
    expect(registry.forSurface('editor')).not.toBe(original)
    expect(guards[0]?.()).toBe(false)
    expect(guards[1]?.()).toBe(true)
    registry.dispose()
    expect(guards[1]?.()).toBe(false)
  })

  it('keeps different sessions and closing one surface independent', async () => {
    vi.useFakeTimers()
    const { registry, sent } = harness()
    try {
      for (const [surface, session] of [
        ['sidebar', 'one'],
        ['editor', 'two'],
      ]) {
        const window = registry.forSurface(surface!)
        window.installPage(session!, { events: [], hasMore: false }, window.begin(session!))
      }
      registry.accept(completed('one', 1))
      registry.accept(completed('two', 1))
      await vi.advanceTimersByTimeAsync(40)
      expect(sent.get('sidebar')).toHaveLength(1)
      expect(sent.get('sidebar')?.[0]?.sessionId).toBe('one')
      expect(sent.get('editor')?.[0]?.sessionId).toBe('two')
      const editor = registry.forSurface('editor')
      editor.acknowledge('two', sent.get('editor')![0]!.revision)
      registry.remove('sidebar')
      registry.accept(completed('two', 2))
      await vi.advanceTimersByTimeAsync(40)
      expect(sent.get('editor')).toHaveLength(2)
      expect(sent.get('sidebar')).toHaveLength(1)
    } finally {
      registry.dispose()
    }
  })

  it('isolates hidden state and acknowledgements even for the same session', async () => {
    vi.useFakeTimers()
    const { registry, sent } = harness()
    try {
      for (const surface of ['sidebar', 'editor']) {
        const window = registry.forSurface(surface)
        window.installPage('shared', { events: [], hasMore: false }, window.begin('shared'))
      }
      registry.setVisible('sidebar', false)
      registry.accept(completed('shared', 1))
      await vi.advanceTimersByTimeAsync(40)
      expect(sent.get('sidebar')).toHaveLength(0)
      expect(sent.get('editor')).toHaveLength(1)
      registry.setVisible('sidebar', true)
      await vi.advanceTimersByTimeAsync(40)
      expect(sent.get('sidebar')).toHaveLength(1)
      registry.forSurface('sidebar').acknowledge('shared', sent.get('sidebar')![0]!.revision)
      registry.accept(completed('shared', 2))
      await vi.advanceTimersByTimeAsync(40)
      expect(sent.get('sidebar')).toHaveLength(2)
      expect(sent.get('editor')).toHaveLength(1)
      registry.forSurface('editor').acknowledge('shared', sent.get('editor')![0]!.revision)
      await vi.advanceTimersByTimeAsync(40)
      expect(sent.get('editor')).toHaveLength(2)
    } finally {
      registry.dispose()
    }
  })

  it('consumes transcript bodies without broadcasting them when no surface exists', () => {
    const { registry } = harness()
    expect(registry.accept(completed('unopened', 1))).toBe(true)
    expect(registry.accept({ type: 'session.status', sessionId: 'unopened', status: 'idle' })).toBe(false)
    registry.dispose()
  })
})
