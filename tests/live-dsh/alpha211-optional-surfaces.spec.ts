import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

/** Real published alpha211 packages; only the drawing mod itself is a test fixture.
 * DSH_LIVE_OPTIONAL_PACKAGE_ROOT explicitly selects the isolated exact package install.
 * No model, tool execution, Chrome launch, production home or external process is used.
 */
describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' ||
    process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.1' ||
    process.env.DSH_LIVE_OPTIONAL_PACKAGE_ROOT === undefined,
)('live DSH alpha211 mounted optional surfaces', () => {
  it(
    'discovers the actual Inspector Worker and reads/presses a real mods Remote',
    async () => {
      const root = process.env.DSH_LIVE_OPTIONAL_PACKAGE_ROOT
      if (root === undefined) throw new Error('The optional package install must be explicit.')
      const require = createRequire(path.join(root, 'package.json'))
      const modsName = '@deepseek-ai/dsh-experimental-claude-code-mods'
      const inspectorName = '@deepseek-ai/dsh-experimental-inspector'
      for (const name of [modsName, inspectorName]) {
        const manifest: unknown = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'))
        expect(manifest).toMatchObject({ name, version: '0.2.1-alpha.1' })
      }
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-alpha211-optional-'))
      const modFile = path.join(home, 'drawing.mjs')
      const patchFile = path.join(home, 'optional.patch.yml')
      await writeFile(
        modFile,
        `
import { defineMod } from ${JSON.stringify(pathToFileURL(require.resolve(modsName)).href)}
let presses = 0
export default defineMod({ name: 'vscode-live-fixture', register(on) {
  on('ui.render', { component: 'AbovePrompt' }, ($, event) => {
    const { Box, Text, Button } = $.ui.resolve(event)
    return Box({ flexDirection: 'row', children: [
      Text({ children: 'Live presses ' + presses }),
      Button({ label: 'Increment', onPress: () => { presses += 1 } })
    ] })
  })
} })
`,
        'utf8',
      )
      const yamlPath = (file: string): string => JSON.stringify(file.replaceAll('\\', '/'))
      await writeFile(
        patchFile,
        `- insert:
    - id: alpha211-live-mods
      name: ${yamlPath(require.resolve(modsName))}
    - id: alpha211-live-drawing
      name: ${yamlPath(modFile)}
    - id: alpha211-live-inspector
      name: ${yamlPath(require.resolve(inspectorName))}
      config:
        port: 0
        captureFetch: false
`,
        'utf8',
      )
      const runtime = await startManagedRuntime({ dshHome: home, removeDshHomeOnStop: true, patchFile })
      let inspectorPort: number | undefined
      try {
        const { backend } = runtime
        if (backend.inspectorDevtools === undefined || backend.modsBand === undefined)
          throw new Error('The exact adapter did not expose optional surface ports.')
        const inspector = await backend.inspectorDevtools.discover()
        expect(inspector.available).toBe(true)
        if (!inspector.available) throw new Error('The Inspector overlay was not mounted.')
        const frontend = new URL(inspector.frontendUrl)
        const socket = frontend.searchParams.get('ws')
        expect(socket).toMatch(/^127\.0\.0\.1:\d+\/devtools\/page\/[A-Za-z0-9_-]+$/u)
        inspectorPort = Number(socket?.split('/')[0]?.split(':')[1])
        expect(await canConnect(inspectorPort)).toBe(true)
        const workspace = await backend.workspaces.create({
          name: 'Optional surfaces',
          path: runtime.snapshot.workspace,
        })
        const session = await backend.sessions.create({
          workspaceId: workspace.id,
          configuration: {
            preset: '',
            toolMode: 'native',
            permissionPreset: '',
            planMode: false,
            model: { providerId: '', modelId: '' },
          },
        })
        const initial = await backend.modsBand.read(session.id)
        expect(initial).toMatchObject({ available: true })
        expect(JSON.stringify(initial.snapshot?.tree)).toContain('Live presses 0')
        const generation = initial.snapshot?.generation
        if (generation === undefined) throw new Error('No live band generation was returned.')
        const pressed = await backend.modsBand.press(session.id, generation, 'a0')
        expect(pressed.generation).toBeGreaterThan(generation)
        expect(JSON.stringify(pressed.tree)).toContain('Live presses 1')
        await expect(backend.modsBand.press(session.id, generation, 'a0')).rejects.toMatchObject({
          code: 'STALE_INTERACTION',
        })
        const controller = new AbortController()
        const watch = expect(
          backend.modsBand.read(session.id, pressed.generation, controller.signal),
        ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
        controller.abort()
        await watch
        console.log(
          '[dsh-live-alpha211-optional] real Inspector bootstrap/Worker and mods watch/press/cancel passed',
        )
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
        if (inspectorPort !== undefined) expect(await canConnect(inspectorPort)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
