import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

const enabled = process.env.DSH_LIVE_SMOKE === '1' && process.env.DSH_LIVE_RUNTIME_VERSION === '0.2.2-rc.3'

/** Source-pinned format-3 archive with invented content and a deliberately absent original file. */
const conversation = {
  id: 'fixture-export',
  title: 'Imported fixture',
  inserted_at: '2026-11-12T00:00:00Z',
  messages: [
    {
      id: 1,
      parent_id: null,
      role: 'USER',
      status: 'FINISHED',
      inserted_at: '2026-11-12T00:00:00Z',
      fragments: [
        { type: 'REQUEST', content: 'Review the fixture' },
        {
          type: 'FILE',
          files: [{ id: 'missing-file', file_name: 'original.txt', is_image: false, export_path: null }],
        },
      ],
    },
    {
      id: 2,
      parent_id: 1,
      role: 'ASSISTANT',
      status: 'FINISHED',
      inserted_at: '2026-11-12T00:00:01Z',
      fragments: [
        { type: 'THINK', content: 'Fixture reasoning' },
        { type: 'RESPONSE', content: 'Fixture reviewed' },
      ],
    },
  ],
}

describe.skipIf(!enabled)('native rc223 imported history and export', () => {
  it(
    'reads imported messages through the exact backend and exports a ZIP with missing-attachment receipts',
    async () => {
      const executable = process.env.DSH_LIVE_RUNTIME
      if (executable === undefined) throw new Error('Select the exact rc223 CLI entry.')
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-rc223-import-'))
      let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
      try {
        const runtimeRequire = createRequire(
          path.join(path.dirname(path.dirname(executable)), 'package.json'),
        )
        const importerEntry = runtimeRequire.resolve('@deepseek-ai/dsh-deepseek-chat-import')
        const zip = createRequire(importerEntry)('fflate') as {
          zipSync(entries: Record<string, Uint8Array>): Uint8Array
          unzipSync(archive: Uint8Array): Record<string, Uint8Array>
        }
        const patchFile = path.join(home, 'import.patch.yml')
        await writeFile(
          patchFile,
          `- insert:\n    - id: deepseek-chat-import\n      name: ${JSON.stringify(importerEntry.replaceAll('\\', '/'))}\n`,
        )
        runtime = await startManagedRuntime({
          dshHome: home,
          patchFile,
          exportFileSystem: { stat, rename, unlink, writeFile },
        })
        const { backend } = runtime
        expect(backend.connection.capabilities).toMatchObject({
          adapterId: 'dsh-0.2.2-rc.3',
          protocolVersion: 'rc223',
          compatibilityMode: 'exact',
        })
        const account = backend.account
        if (account === undefined) throw new Error('The rc223 account port is missing.')
        expect(await account.getState()).toMatchObject({ status: 'signed-out', credentialRevision: 0 })
        const controller = new AbortController()
        const streamSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
        const updates = account.watch(streamSignal)[Symbol.asyncIterator]()
        try {
          expect((await updates.next()).value).toMatchObject({ status: 'signed-out', credentialRevision: 0 })
        } finally {
          controller.abort()
          await updates.return?.()
        }
        const bundles = await backend.pluginBundles?.listBundles()
        expect(bundles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: '@deepseek-ai/dsh-deepseek-chat-import', official: true }),
          ]),
        )
        const workspace = await backend.workspaces.create({
          name: 'Imported fixture',
          path: runtime.snapshot.workspace,
        })
        if (runtime.launchUrl === undefined) throw new Error('Missing isolated runtime login URL.')
        const login = await fetch(runtime.launchUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .find((value) => value?.includes('='))
        if (cookie === undefined) throw new Error('The isolated login returned no credential.')
        const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
        const archive = Buffer.from(
          zip.zipSync({
            'manifest.json': json({ export_format_version: 3 }),
            'chat_session_index.json': json([
              {
                id: conversation.id,
                inserted_at: conversation.inserted_at,
                updated_at: '2026-11-12T00:00:01Z',
              },
            ]),
            'chat_sessions/fixture-export.json': json(conversation),
          }),
        )
        const url = new URL('/api/deepseek-chat-import/archive', backend.connection.endpoint.baseUrl)
        url.searchParams.set('workspaceId', workspace.id)
        const upload = await fetch(url, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/octet-stream' },
          body: archive,
          signal: AbortSignal.timeout(15_000),
        })
        expect(upload.status).toBe(200)
        const lines = (await upload.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown)
        expect(lines.at(-1)).toMatchObject({ type: 'outcome', outcome: { ok: true } })
        const sessions = await backend.sessions.list()
        const imported = sessions.items.find((item) => item.title === conversation.title)
        if (imported === undefined)
          throw new Error('The imported conversation is absent from the session list.')
        expect(imported.workspaceId).toBe(workspace.id)
        await vi.waitFor(async () => {
          const history = await backend.sessions.history(imported.id)
          const events = history.events.map(({ event }) => event)
          expect(events.find((event) => event.type === 'message.user')).toMatchObject({
            markdown: 'Review the fixture',
            attachments: [{ name: 'original.txt' }],
          })
          expect(events.find((event) => event.type === 'message.completed')).toMatchObject({
            markdown: 'Fixture reviewed',
            reasoning: 'Fixture reasoning',
          })
        })
        const destination = path.join(runtime.snapshot.workspace, 'imported.zip')
        await backend.exports.exportSession(
          { sessionId: imported.id, format: 'zip', includeAttachments: true, includeReasoning: true },
          destination,
        )
        const entries = zip.unzipSync(await readFile(destination))
        expect(entries['attachments-missing.txt']).toBeDefined()
        expect(new TextDecoder().decode(entries['attachments-missing.txt'])).toContain('original.txt')
        const logs = Object.entries(entries).filter(([name]) => name.endsWith('.jsonl'))
        expect(logs.length).toBeGreaterThan(0)
        expect(logs.map(([, bytes]) => new TextDecoder().decode(bytes)).join('\n')).toContain(
          'Fixture reviewed',
        )
      } finally {
        if (runtime !== undefined) {
          await runtime.stop()
          expect(await canConnect(runtime.snapshot.port)).toBe(false)
        }
        await rm(home, { recursive: true, force: true })
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
