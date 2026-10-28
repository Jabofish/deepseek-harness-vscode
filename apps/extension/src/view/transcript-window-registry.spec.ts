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
  it('routes root, pending and child sessions without treating an addressed child as unbound', () => {
    const { registry } = harness()
    try {
      expect(registry.surfacesForSession('root')).toBeUndefined()
      const root = registry.forSurface('sidebar')
      // A created but unassigned window still needs broadcast recovery.
      expect(registry.surfacesForSession('root')).toBeUndefined()
      root.installPage('root', { events: [], hasMore: false }, root.begin('root'))
      const child = registry.forSurface('editor')
      child.installPage('child', { events: [], hasMore: false }, child.begin('child', true))
      expect(registry.surfacesForSession('root')).toEqual(['sidebar'])
      expect(registry.surfacesForSession('child')).toEqual(['editor'])
      expect(registry.surfacesForSession('background')).toEqual([])
      const opening = root.begin('next')
      expect(registry.surfacesForSession('next')).toEqual(['sidebar'])
      root.cancel(opening)
      expect(registry.surfacesForSession('root')).toEqual(['sidebar'])
    } finally {
      registry.dispose()
    }
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

  it('consumes transcript bodies without broadcasting them when no surface exists', () => {
    const { registry } = harness()
    expect(registry.accept(completed('unopened', 1))).toBe(true)
    expect(registry.accept({ type: 'session.status', sessionId: 'unopened', status: 'idle' })).toBe(false)
    registry.dispose()
  })
})
