import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from './protocol-client.js'

const vscodeState = vi.hoisted((): { value: unknown } => ({ value: undefined }))

vi.mock('../vscode-api.js', () => ({
  getVsCodeApi: () => ({
    postMessage: () => undefined,
    getState: () => vscodeState.value,
    setState: (value: unknown) => {
      vscodeState.value = value
    },
  }),
}))

import { createAppStore } from './store.js'
import {
  activateDraftOwner,
  adoptSavedDrafts,
  readDraft,
  resetDraft,
  restoreDrafts,
  setDraft,
} from './draft-store.js'

const client = {
  subscribe: () => () => {},
  dispose: () => {},
  request: () => new Promise(() => {}),
} as unknown as ProtocolClient

describe('composer draft persistence', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetDraft()
    activateDraftOwner(undefined)
    vscodeState.value = undefined
  })

  it('saves unsent drafts and gives them to the next Webview instance', () => {
    vi.useFakeTimers()
    vscodeState.value = { version: 1, drafts: { 'session-a': 'kept from before', '': 'pending text' } }
    const first = createAppStore(client)
    resetDraft()
    restoreDrafts(first.takeSavedDrafts?.() ?? {})
    activateDraftOwner('session-a')
    expect(readDraft()).toBe('kept from before')
    setDraft('kept from before, edited')
    vi.advanceTimersByTime(300)
    expect(vscodeState.value).toMatchObject({
      drafts: { 'session-a': 'kept from before, edited', '': 'pending text' },
    })
    first.dispose()

    resetDraft()
    activateDraftOwner(undefined)
    const second = createAppStore(client)
    restoreDrafts(second.takeSavedDrafts?.() ?? {})
    expect(readDraft()).toBe('pending text')
    activateDraftOwner('session-a')
    expect(readDraft()).toBe('kept from before, edited')
    second.dispose()
  })

  it('keeps saved drafts until the composer takes them and ignores malformed entries', () => {
    vscodeState.value = { version: 1, drafts: { 'session-a': 'saved', broken: 42, empty: '  ' } }
    const store = createAppStore(client)
    store.setDrawer(undefined)
    expect((vscodeState.value as { drafts?: unknown }).drafts).toEqual({ 'session-a': 'saved' })
    expect(store.takeSavedDrafts?.()).toEqual({ 'session-a': 'saved' })
    store.dispose()
  })

  it('keeps every draft when the composer remounts while text is being typed', () => {
    vi.useFakeTimers()
    vscodeState.value = { version: 1, drafts: { 'session-b': 'other chat' } }
    const store = createAppStore(client)
    adoptSavedDrafts(() => store.takeSavedDrafts?.() ?? {})
    activateDraftOwner('session-a')
    setDraft('typed just now')
    // An error-boundary recovery remounts App with the same store before the
    // batched write ran.
    adoptSavedDrafts(() => store.takeSavedDrafts?.() ?? {})
    expect(readDraft()).toBe('typed just now')
    vi.advanceTimersByTime(300)
    expect(vscodeState.value).toMatchObject({
      drafts: { 'session-a': 'typed just now', 'session-b': 'other chat' },
    })
    activateDraftOwner('session-b')
    expect(readDraft()).toBe('other chat')
    store.dispose()
  })

  it('keeps the most recently edited drafts when more conversations have one than are saved', () => {
    vi.useFakeTimers()
    const store = createAppStore(client)
    adoptSavedDrafts(() => store.takeSavedDrafts?.() ?? {})
    for (let index = 0; index < 21; index += 1) {
      activateDraftOwner(`session-${index}`)
      setDraft(`draft ${index}`)
    }
    activateDraftOwner('session-0')
    setDraft('draft 0, still being written')
    vi.advanceTimersByTime(300)
    const saved = (vscodeState.value as { drafts: Record<string, string> }).drafts
    expect(Object.keys(saved)).toHaveLength(20)
    expect(saved['session-0']).toBe('draft 0, still being written')
    expect(saved['session-1']).toBeUndefined()
    store.dispose()
  })
})
