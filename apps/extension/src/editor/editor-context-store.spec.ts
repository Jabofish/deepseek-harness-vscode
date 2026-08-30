import {
  AppError,
  EDITOR_CONTEXT_LIMITS,
  type EditorContextItem,
  type EditorContextOwner,
  type EditorContextResolveInput,
} from '@dsh-vscode/domain'
import { describe, expect, it } from 'vitest'

import { EditorContextStore } from './editor-context-store.js'

const owner: EditorContextOwner = {
  ownerId: 'owner',
  ownerViewId: 'view',
  contextStoreGeneration: 1,
  workspaceFolderId: 'workspace-1',
}

const binding = (sessionId = 'session-1'): EditorContextResolveInput => ({
  ...owner,
  sessionId,
  backendInstanceId: 'backend-1',
  connectionGeneration: 3,
  contextRefs: [],
})

function capture(
  store: EditorContextStore,
  text: string,
  options: {
    readonly path?: string
    readonly version?: number
    readonly readCurrent?: () => Promise<{ readonly bytes: Uint8Array; readonly documentVersion?: number }>
  } = {},
): EditorContextItem {
  return store.capture({
    workspaceFolderId: owner.workspaceFolderId!,
    ownerId: owner.ownerId,
    ownerViewId: owner.ownerViewId,
    contextStoreGeneration: owner.contextStoreGeneration,
    kind: 'selection',
    relativePath: options.path ?? 'src/index.ts',
    range: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: text.length },
    },
    label: 'selection: src/index.ts',
    bytes: Buffer.from(text),
    mimeType: 'text/typescript',
    ...(options.version === undefined ? {} : { documentVersion: options.version }),
    ...(options.readCurrent === undefined ? {} : { readCurrent: options.readCurrent }),
  })
}

function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code })
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('EditorContextStore', () => {
  it('keeps bytes host-side and resolves a fresh context exactly once for a session', async () => {
    let current = Buffer.from('const value = 1')
    let version = 7
    const store = new EditorContextStore(
      () => 1_000,
      () => 'context-1',
    )
    const item = capture(store, current.toString(), {
      version,
      readCurrent: () => Promise.resolve({ bytes: current, documentVersion: version }),
    })

    expect(item.ref.contextRef).toBe('dsh-context:context-1')
    expect(item.ref.contentHash).toHaveLength(64)
    expect(Object.keys(item)).toEqual(['ref', 'label', 'stale', 'previewAvailable'])
    expect(await store.preview(item.ref.contextRef, owner)).toMatchObject({
      contextRef: item.ref.contextRef,
      text: 'const value = 1',
      truncated: false,
    })

    const input = { ...binding(), contextRefs: [item.ref.contextRef] }
    const resolved = await store.resolveForPrompt(input)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.attachment.uri).toContain('data:text/typescript;base64,')
    expect((await store.list(owner))[0]?.ref.sessionId).toBe('session-1')

    current = Buffer.from('const value = 2')
    version += 1
    await expectAppError(store.preview(item.ref.contextRef, owner), 'CONTEXT_STALE')
    const next = { ...binding('session-2'), contextRefs: [item.ref.contextRef] }
    await expectAppError(store.resolveForPrompt(next), 'GENERATION_MISMATCH')
  })

  it('rejects a batch atomically when one item is stale', async () => {
    let second = Buffer.from('second')
    let nextId = 0
    const store = new EditorContextStore(
      () => 1_000,
      () => `context-${++nextId}`,
    )
    const first = capture(store, 'first')
    const secondItem = capture(store, 'second', { readCurrent: () => Promise.resolve({ bytes: second }) })
    second = Buffer.from('changed')

    const input = { ...binding(), contextRefs: [first.ref.contextRef, secondItem.ref.contextRef] }
    await expectAppError(store.resolveForPrompt(input), 'CONTEXT_STALE')
    expect((await store.list(owner)).map((item) => item.ref.sessionId)).toEqual([undefined, undefined])
  })

  it('reserves an unbound context before an async read so another session cannot claim it', async () => {
    const current = deferred<{ readonly bytes: Uint8Array }>()
    const store = new EditorContextStore(
      () => 1_000,
      () => 'context-1',
    )
    const item = capture(store, 'stable', { readCurrent: () => current.promise })
    const first = store.resolveForPrompt({ ...binding('session-1'), contextRefs: [item.ref.contextRef] })

    await expectAppError(
      store.resolveForPrompt({ ...binding('session-2'), contextRefs: [item.ref.contextRef] }),
      'GENERATION_MISMATCH',
    )
    current.resolve({ bytes: Buffer.from('stable') })
    await expect(first).resolves.toHaveLength(1)
  })

  it('does not finish a pending resolution after the view clears its handles', async () => {
    const current = deferred<{ readonly bytes: Uint8Array }>()
    const store = new EditorContextStore(
      () => 1_000,
      () => 'context-1',
    )
    const item = capture(store, 'stable', { readCurrent: () => current.promise })
    const resolving = store.resolveForPrompt({ ...binding(), contextRefs: [item.ref.contextRef] })
    store.clear()
    current.resolve({ bytes: Buffer.from('stable') })

    await expectAppError(resolving, 'CONTEXT_EXPIRED')
  })

  it('marks stale items, enforces ownership and releases the exact view', async () => {
    let current = Buffer.from('stable')
    const store = new EditorContextStore(
      () => 1_000,
      () => 'context-1',
    )
    const item = capture(store, current.toString(), {
      readCurrent: () => Promise.resolve({ bytes: current }),
    })
    current = Buffer.from('different')
    expect((await store.list(owner))[0]).toMatchObject({ stale: true, previewAvailable: false })

    expect(await store.list({ ...owner, ownerId: 'other' })).toEqual([])
    await expectAppError(
      store.preview(item.ref.contextRef, { ...owner, contextStoreGeneration: 2 }),
      'GENERATION_MISMATCH',
    )
    store.release([item.ref.contextRef], owner)
    expect(store.size).toBe(0)
  })

  it('expires entries and enforces item, total and reference-count limits', async () => {
    let now = 10_000
    let nextId = 0
    const store = new EditorContextStore(
      () => now,
      () => `context-${++nextId}`,
    )
    const item = capture(store, 'short')
    now += EDITOR_CONTEXT_LIMITS.ttlMs
    expect(store.size).toBe(0)
    await expectAppError(store.preview(item.ref.contextRef, owner), 'CONTEXT_EXPIRED')

    const oversized = new EditorContextStore(
      () => 1_000,
      () => 'large',
    )
    expect(() =>
      oversized.capture({
        workspaceFolderId: owner.workspaceFolderId!,
        ownerId: owner.ownerId,
        ownerViewId: owner.ownerViewId,
        contextStoreGeneration: 1,
        kind: 'file',
        relativePath: 'large.txt',
        label: 'large',
        bytes: new Uint8Array(EDITOR_CONTEXT_LIMITS.maxItemBytes + 1),
        mimeType: 'text/plain',
      }),
    ).toThrowError(AppError)

    let limitedNextId = 0
    const limited = new EditorContextStore(
      () => 1_000,
      () => `context-${++limitedNextId}`,
      {
        ...EDITOR_CONTEXT_LIMITS,
        maxItems: 1,
      },
    )
    capture(limited, 'one')
    expect(() => capture(limited, 'two')).toThrowError(AppError)
    const input = { ...binding(), contextRefs: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }
    await expectAppError(limited.resolveForPrompt(input), 'CONTEXT_LIMIT')
  })

  it('clears all handles on view disposal', () => {
    const store = new EditorContextStore(
      () => 1_000,
      () => 'context-1',
    )
    capture(store, 'content')
    store.clear()
    expect(store.size).toBe(0)
  })
})
