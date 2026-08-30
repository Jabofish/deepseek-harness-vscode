import { createHash } from 'node:crypto'

import { type PromptTemplateSummary } from '@dsh-vscode/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PromptTemplateStore } from './prompt-template-store.js'
import type { PromptTemplateScopeStorage } from './prompt-template-store.js'

interface MemoryStorage extends PromptTemplateScopeStorage {
  readonly files: Map<string, Uint8Array>
  failWrites: boolean
  abortOnWrite: AbortController | undefined
}

function memoryStorage(): MemoryStorage {
  const files = new Map<string, Uint8Array>()
  const storage: MemoryStorage = {
    files,
    failWrites: false,
    abortOnWrite: undefined,
    mkdir(): Promise<void> {
      return Promise.resolve()
    },
    read(name): Promise<Uint8Array | undefined> {
      const value = files.get(name)
      return Promise.resolve(value === undefined ? undefined : new Uint8Array(value))
    },
    write(name, data): Promise<void> {
      if (storage.failWrites) throw new Error('disk full')
      if (storage.abortOnWrite !== undefined) {
        storage.abortOnWrite.abort()
        storage.abortOnWrite = undefined
      }
      files.set(name, new Uint8Array(data))
      return Promise.resolve()
    },
    rename(sourceName, destinationName, overwrite): Promise<void> {
      const value = files.get(sourceName)
      if (value === undefined) throw fileNotFound()
      if (!overwrite && files.has(destinationName)) throw new Error('already exists')
      files.set(destinationName, value)
      files.delete(sourceName)
      return Promise.resolve()
    },
    delete(name): Promise<void> {
      files.delete(name)
      return Promise.resolve()
    },
  }
  return storage
}

function fileNotFound(): Error {
  const error = new Error('missing') as Error & { code?: string }
  error.code = 'FileNotFound'
  return error
}

function createHarness(options: { readonly trusted?: boolean; readonly enabled?: boolean } = {}): {
  readonly store: PromptTemplateStore
  readonly global: MemoryStorage
  readonly workspaces: Map<string, MemoryStorage>
} {
  const global = memoryStorage()
  const workspaces = new Map<string, MemoryStorage>()
  let nextId = 0
  const store = new PromptTemplateStore({
    global,
    workspace: (workspaceFolderId) => {
      let storage = workspaces.get(workspaceFolderId)
      if (storage === undefined) {
        storage = memoryStorage()
        workspaces.set(workspaceFolderId, storage)
      }
      return storage
    },
    enabled: () => options.enabled ?? true,
    workspaceTrusted: () => options.trusted ?? true,
    now: () => 1_000 + nextId,
    makeId: () => `id-${nextId++}`,
  })
  return { store, global, workspaces }
}

const owner = { workspaceFolderId: 'workspace-1', sessionId: 'session-1' }

async function createTemplate(
  store: PromptTemplateStore,
  overrides: Partial<Parameters<PromptTemplateStore['create']>[0]> = {},
  signal?: AbortSignal,
): Promise<PromptTemplateSummary> {
  return store.create(
    {
      title: 'Review',
      description: 'Review the current change.',
      templateText: 'Review {{selection}} in {{currentFile}}.',
      scope: 'global',
      variables: ['selection', 'currentFile'],
      ...overrides,
    },
    owner,
    signal,
  )
}

describe('PromptTemplateStore', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates, lists, reads and expands a global template without sending it anywhere', async () => {
    const { store } = createHarness()
    const summary = await createTemplate(store)

    expect(summary.title).toBe('Review')
    expect(await store.list(owner)).toEqual([summary])
    expect((await store.read(summary.templateId, owner)).templateText).toContain('{{selection}}')
    expect(
      (await store.insert(summary.templateId, { selection: 'the diff', currentFile: 'src/app.ts' }, owner))
        .text,
    ).toBe('Review the diff in src/app.ts.')
  })

  it('keeps unresolved variables explicit and permits an empty user value', async () => {
    const { store } = createHarness()
    const summary = await createTemplate(store, {
      templateText: 'Explain {{selection}} for {{workspaceName}}.',
      variables: ['selection', 'workspaceName'],
    })

    const unresolved = await store.insert(summary.templateId, { selection: 'this code' }, owner)
    expect(unresolved.unresolvedVariables).toEqual(['workspaceName'])
    expect(unresolved.text).toContain('{{workspaceName}}')
    const empty = await store.insert(summary.templateId, { selection: 'this code', workspaceName: '' }, owner)
    expect(empty.unresolvedVariables).toEqual([])
    expect(empty.text).toBe('Explain this code for .')
  })

  it('rejects undeclared or unsupported variables and never evaluates template text', async () => {
    const { store } = createHarness()
    await expect(
      createTemplate(store, { templateText: 'Run {{shell}}', variables: ['shell'] }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    const summary = await createTemplate(store, {
      templateText: '<script>ignored</script> {{selection}}',
      variables: ['selection'],
    })
    const inserted = await store.insert(summary.templateId, { selection: 'safe' }, owner)
    expect(inserted.text).toBe('<script>ignored</script> safe')
  })

  it('enforces trust and ownership for workspace and session templates', async () => {
    const untrusted = createHarness({ trusted: false })
    await expect(createTemplate(untrusted.store, { scope: 'workspace' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await expect(untrusted.store.list({ ...owner, scope: 'workspace' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })

    const { store } = createHarness()
    const sessionTemplate = await createTemplate(store, { scope: 'session' })
    await expect(
      store.read(sessionTemplate.templateId, {
        workspaceFolderId: owner.workspaceFolderId,
        sessionId: 'other',
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_NOT_OWNED',
    })
    const workspaceTemplate = await createTemplate(store, { scope: 'workspace' })
    expect(
      (await store.list(owner, undefined)).some((item) => item.templateId === workspaceTemplate.templateId),
    ).toBe(true)
  })

  it('marks a missing or malformed body disabled instead of repeatedly reading corrupt content', async () => {
    const { store, global } = createHarness()
    const summary = await createTemplate(store)
    const index = JSON.parse(
      Buffer.from(global.files.get('index.json') ?? new Uint8Array()).toString('utf8'),
    ) as {
      templates: Array<{ bodyRef: string }>
    }
    global.files.delete(index.templates[0]?.bodyRef ?? '')

    await expect(store.read(summary.templateId, owner)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
    await expect(store.insert(summary.templateId, undefined, owner)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('rejects duplicate or tampered index metadata on a fresh load', async () => {
    const first = createHarness()
    const summary = await createTemplate(first.store)
    const index = JSON.parse(
      Buffer.from(first.global.files.get('index.json') ?? new Uint8Array()).toString('utf8'),
    ) as {
      version: 1
      templates: readonly unknown[]
    }
    const payload = { version: 1, templates: [...index.templates, index.templates[0]] }
    first.global.files.set(
      'index.json',
      Buffer.from(
        JSON.stringify({
          ...payload,
          checksum: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
        }),
      ),
    )
    const second = new PromptTemplateStore({
      global: first.global,
      workspace: () => undefined,
      workspaceTrusted: () => true,
    })
    await expect(second.list(owner)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
    expect(summary.templateId).toContain('dsh-template-')
  })

  it('rolls back a failed write and cancellation before rename', async () => {
    const { store, global } = createHarness()
    global.failWrites = true
    await expect(createTemplate(store)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
    expect([...global.files.keys()]).toEqual([])

    global.failWrites = false
    const controller = new AbortController()
    global.abortOnWrite = controller
    await expect(createTemplate(store, {}, controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect([...global.files.keys()]).toEqual(['index.json'])
  })

  it('honors the disabled setting without creating storage entries', async () => {
    const { store, global } = createHarness({ enabled: false })
    await expect(store.list(owner)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(createTemplate(store)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    expect([...global.files.keys()]).toEqual([])
  })

  it('updates with a new body reference and deletes only after the index commit', async () => {
    const { store, global } = createHarness()
    const summary = await createTemplate(store)
    const before = [...global.files.keys()].find((name) => name.startsWith('template-'))
    expect(before).toBeDefined()
    const next = await store.update(
      summary.templateId,
      { templateText: 'Updated {{selection}}', variables: ['selection'] },
      owner,
    )
    const after = [...global.files.keys()].find((name) => name.startsWith('template-'))
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect((await store.read(next.templateId, owner)).templateText).toBe('Updated {{selection}}')
  })
})
