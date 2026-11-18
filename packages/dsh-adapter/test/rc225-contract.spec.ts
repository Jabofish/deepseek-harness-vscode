import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc225VersionAdapter } from '../src/versions/rc225/adapter.js'
import { Rc224VersionAdapter } from '../src/versions/rc224/adapter.js'
import { rc222SessionProfile } from '../src/versions/rc222/session-wire.js'
import {
  readAlpha171SessionSnapshot,
  validAlpha171SessionSnapshot,
} from '../src/versions/alpha171/session-wire.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Rc6SettingsRepository } from '../src/repositories/settings-repository.js'
import { Rc6ExportRepository, type ExportFileSystem } from '../src/repositories/export-repository.js'
import {
  rc225SearchRequestEvent,
  rc225SearchSessionSnapshot,
  rc225SettingsDescribe,
} from './fixtures/rc225-contract.js'
import { candidate, transportOptions } from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

const tempRoots: string[] = []

const nodeFileSystem: ExportFileSystem = {
  stat,
  rename: async (source, destination, overwrite = false) => {
    if (overwrite) await unlink(destination).catch(() => undefined)
    await rename(source, destination)
  },
  unlink,
  writeFile: (filePath, data) => writeFile(filePath, data),
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('published rc225 consumed contracts', () => {
  it('admits 0.2.2-rc.5 only and rejects adjacent releases including rc.4 and rc.6', async () => {
    const rc225Probe = new ProbeFixtureTransport()
    const rc224Probe = new ProbeFixtureTransport()
    class Rc225Adapter extends Rc225VersionAdapter {
      public override createTransport(): DshTransport {
        return rc225Probe
      }
    }
    class Rc224Adapter extends Rc224VersionAdapter {
      public override createTransport(): DshTransport {
        return rc224Probe
      }
    }
    const rc225 = new Rc225Adapter(transportOptions(globalThis.fetch))
    const rc224 = new Rc224Adapter(transportOptions(globalThis.fetch))

    expect(await rc225.probe(candidate('0.2.2-rc.5'))).toMatchObject({
      adapterId: 'dsh-0.2.2-rc.5',
      protocolVersion: 'rc225',
      dshVersion: '0.2.2-rc.5',
      compatibilityMode: 'exact',
    })
    expect(await rc225.probe(candidate('0.2.2-rc.4'))).toBeUndefined()
    expect(await rc225.probe(candidate('0.2.2-rc.6'))).toBeUndefined()
    expect(await rc224.probe(candidate('0.2.2-rc.5'))).toBeUndefined()
    expect(rc225Probe.closeCalls).toBe(1)
    expect(rc224Probe.closeCalls).toBe(0)
  })

  it('validates web/deepseek-search-llm-request in V4 snapshots, redacts private fields, and omits it from Markdown export', async () => {
    expect(validAlpha171SessionSnapshot(rc225SearchSessionSnapshot, rc222SessionProfile)).toBe(true)
    const validated = readAlpha171SessionSnapshot(rc225SearchSessionSnapshot, rc222SessionProfile)
    expect(validated?.records).toHaveLength(rc225SearchSessionSnapshot.records.length)

    const mapped = rc6Mapper.history(
      { events: validated!.records, hasMore: false, projections: validated!.projections },
      'rc225-search-session',
    )
    const searchRequest = mapped.events.find(
      (entry) => entry.event.type === 'unknown' && entry.event.name === 'web/deepseek-search-llm-request',
    )
    expect(searchRequest).toBeDefined()
    expect(JSON.stringify(searchRequest)).not.toContain('search-gateway.invalid')
    expect(JSON.stringify(searchRequest)).not.toContain('Private search fixture query')
    expect(searchRequest?.event).toMatchObject({
      type: 'unknown',
      name: 'web/deepseek-search-llm-request',
      payload: {
        data: {
          apiVersion: rc225SearchRequestEvent.data.apiVersion,
        },
      },
    })
    const payloadData =
      searchRequest?.event.type === 'unknown'
        ? (searchRequest.event.payload as { data?: Record<string, unknown> } | undefined)?.data
        : undefined
    expect(payloadData).toEqual({
      apiVersion: rc225SearchRequestEvent.data.apiVersion,
    })

    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-rc225-export-'))
    tempRoots.push(root)
    const markdownPath = path.join(root, 'session.md')
    const jsonPath = path.join(root, 'session.json')
    const transport: DshTransport = {
      request: <TResponse>(method: string): Promise<TResponse> => {
        if (method === 'session.export' || method === 'session.history') {
          return Promise.resolve({
            result: {
              ok: true,
              value: {
                events: validated!.records.map((entry) => entry.event),
                hasMore: false,
              },
            },
          } as TResponse)
        }
        return Promise.reject(new Error(`Unexpected RPC ${method}`))
      },
      remoteRequest: <TResponse>(): Promise<TResponse> => Promise.reject(new Error('unused')),
      openEventStream: async function* () {},
      close: (): Promise<void> => Promise.resolve(),
    }
    const exporter = new Rc6ExportRepository(transport, nodeFileSystem)
    await exporter.exportSession(
      {
        sessionId: 'rc225-search-session',
        format: 'markdown',
        includeAttachments: false,
        includeReasoning: true,
      },
      markdownPath,
    )
    const markdown = await readFile(markdownPath, 'utf8')
    expect(markdown).not.toContain('web/deepseek-search-llm-request')
    expect(markdown).not.toContain('search-gateway.invalid')

    await exporter.exportSession(
      {
        sessionId: 'rc225-search-session',
        format: 'json',
        includeAttachments: false,
        includeReasoning: true,
      },
      jsonPath,
    )
    const exported = JSON.parse(await readFile(jsonPath, 'utf8')) as Array<{ type: string }>
    expect(exported.some((entry) => entry.type === 'web/deepseek-search-llm-request')).toBe(true)
  })

  it('reads omitted web.searchProvider as automatic and round-trips explicit set/unset mutations safely', async () => {
    const calls: { method: string; params: unknown }[] = []
    let current = structuredClone(rc225SettingsDescribe) as unknown as {
      writable: boolean
      hasDocument: boolean
      namespaces: Array<{
        ns: string
        schema: unknown
        value: Record<string, unknown>
        base?: Record<string, unknown>
        user?: Record<string, unknown>
        applies: 'live' | 'restart'
        secrets: readonly { path: readonly string[]; set: boolean }[]
        revision: number
      }>
    }
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown): Promise<TResponse> => {
        calls.push({ method, params })
        if (method === 'settings.describe')
          return Promise.resolve({ result: { ok: true, value: current } } as TResponse)
        if (method === 'settings.mutate') {
          const input = params as {
            ns: string
            ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>
            expectedRevision: number
          }
          const target = current.namespaces.find((entry) => entry.ns === input.ns)!
          const nextValue = { ...target.value }
          const nextUser = { ...(target.user ?? {}) }
          for (const op of input.ops) {
            const key = op.path[0]!
            if (op.op === 'set') {
              nextValue[key] = op.value
              nextUser[key] = op.value
            } else {
              delete nextValue[key]
              delete nextUser[key]
            }
          }
          const updated = {
            ...target,
            value: nextValue,
            ...(Object.keys(nextUser).length === 0 ? {} : { user: nextUser }),
            revision: target.revision + 1,
          }
          if (Object.keys(nextUser).length === 0) delete updated.user
          current = {
            ...current,
            namespaces: current.namespaces.map((entry) => (entry.ns === input.ns ? updated : entry)),
          }
          return Promise.resolve({ result: { ok: true, value: updated } } as TResponse)
        }
        return Promise.reject(new Error(`Unexpected RPC ${method}`))
      },
      remoteRequest: <TResponse>(): Promise<TResponse> => Promise.reject(new Error('unused')),
      openEventStream: async function* () {},
      close: (): Promise<void> => Promise.resolve(),
    }

    const settings = new Rc6SettingsRepository(transport)
    const initial = await settings.readSnapshot()
    expect(initial.values['web']).toEqual({ fetchProvider: 'http' })
    expect(initial.schema.namespaces.find((entry) => entry.ns === 'web')?.userFields).toEqual([])
    expect(initial.values['web-search-deepseek']).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      maxUses: 5,
      apiKey: undefined,
    })

    await settings.mutate('web', [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }], 1)
    const overridden = await settings.readSnapshot()
    expect(overridden.values['web']).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
    expect(overridden.schema.namespaces.find((entry) => entry.ns === 'web')?.userFields).toEqual([
      'searchProvider',
    ])

    await settings.mutate('web', [{ op: 'unset', path: ['searchProvider'] }], 2)
    const restored = await settings.readSnapshot()
    expect(restored.values['web']).toEqual({ fetchProvider: 'http' })
    expect(restored.schema.namespaces.find((entry) => entry.ns === 'web')?.userFields).toEqual([])
  })
})
