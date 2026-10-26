import { describe, expect, it, vi } from 'vitest'

import { WebviewSurfaceRegistry } from './webview-surface-registry.js'
import type { WebviewSurface, WebviewSurfaceKind } from './webview-surface.js'

interface FakeSurface extends WebviewSurface {
  disposed: boolean
  readonly posted: unknown[]
}

function surface(
  surfaceId: string,
  kind: WebviewSurfaceKind,
  options: { readonly visible?: boolean; readonly accepts?: boolean; readonly throws?: boolean } = {},
): FakeSurface {
  const posted: unknown[] = []
  const fake: FakeSurface = {
    surfaceId,
    kind,
    sessionId: kind === 'editor' ? surfaceId.replace('editor:', '') : undefined,
    visible: options.visible ?? true,
    isReady: true,
    disposed: false,
    posted,
    postMessage(message: unknown): Promise<boolean> {
      if (options.throws === true) throw new Error('the Webview is disposed')
      posted.push(message)
      return Promise.resolve(options.accepts ?? true)
    },
    waitUntilReady: () => Promise.resolve(true),
    reveal: () => Promise.resolve(),
    dispose(): void {
      fake.disposed = true
    },
  }
  return fake
}

describe('WebviewSurfaceRegistry', () => {
  it('reports a missed ready surface even when another chat accepted the broadcast', async () => {
    const registry = new WebviewSurfaceRegistry()
    registry.register(surface('sidebar', 'sidebar', { accepts: false }))
    registry.register(surface('editor:s1', 'editor'))
    const missed = vi.fn()
    expect(await registry.post({ message: 'control' }, missed)).toBe(true)
    expect(missed).toHaveBeenCalledExactlyOnceWith('sidebar')
    registry.dispose()
  })

  it('targets one surface and refuses an unknown or throwing target', async () => {
    const registry = new WebviewSurfaceRegistry()
    const sidebar = surface('sidebar', 'sidebar')
    const editor = surface('editor:s1', 'editor', { throws: true })
    registry.register(sidebar)
    registry.register(editor)

    expect(await registry.postTo('sidebar', { message: 'assigned' })).toBe(true)
    expect(sidebar.posted).toEqual([{ message: 'assigned' }])
    expect(editor.posted).toEqual([])
    expect(await registry.postTo('editor:s1', { message: 'assigned' })).toBe(false)
    expect(await registry.postTo('editor:missing', { message: 'assigned' })).toBe(false)
  })

  it('prefers the most recently registered visible surface for user actions', () => {
    const registry = new WebviewSurfaceRegistry()
    const sidebar = surface('sidebar', 'sidebar')
    const hiddenEditor = surface('editor:old', 'editor', { visible: false })
    registry.register(sidebar)
    registry.register(hiddenEditor)

    expect(registry.active).toBe(sidebar)

    const visibleEditor = surface('editor:new', 'editor')
    registry.register(visibleEditor)
    expect(registry.active).toBe(visibleEditor)

    registry.unregister('editor:new')
    expect(registry.active).toBe(sidebar)
    expect(registry.editorCount).toBe(1)
    expect(registry.isEmpty()).toBe(false)
  })
})
