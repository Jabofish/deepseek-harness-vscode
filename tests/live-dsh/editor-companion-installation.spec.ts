import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import type { DshBackend } from '@dsh-vscode/domain'
import type { SpawnedChild } from '../../apps/extension/src/backend/process-supervisor.js'
import { startManagedRuntime, type ManagedLiveRuntime } from './harness.js'
import { spawnManagedChild } from '../../apps/extension/src/composition/runtime.js'
import { EditorCompanionManagement } from '../../apps/extension/src/editor/editor-companion-management.js'
import {
  checkCompanionPackageManager,
  resolveCompanionPackageManager,
} from '../../apps/extension/src/editor/companion-prerequisites.js'
import {
  FixtureUri,
  native,
  resetCompanionFixture,
} from '../../apps/extension/src/editor/test-fixtures/companion-vscode.js'

vi.mock('vscode', async () =>
  (
    await import('../../apps/extension/src/editor/test-fixtures/companion-vscode.js')
  ).createCompanionVscodeApi(),
)

const enabled = process.env.DSH_LIVE_SMOKE === '1' && process.env.DSH_LIVE_EDITOR_COMPANION === '1'
describe.skipIf(!enabled)('companion Host installation with a real isolated DSH', () => {
  it('uses verified pnpm, installs, reconnects, updates and recovers a failed update with accurate feedback', async () => {
    resetCompanionFixture()
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-companion-install-'))
    const previousPath = process.env.PATH
    let runtime: ManagedLiveRuntime | undefined
    let ownedBackend: DshBackend | undefined
    let manager: EditorCompanionManagement | undefined
    let launchOutput = ''
    let launches = 0
    const capture = async function* (stream: AsyncIterable<string>): AsyncIterable<string> {
      for await (const chunk of stream) {
        launchOutput = (launchOutput + chunk).slice(-6_000)
        yield chunk
      }
    }
    try {
      const broken = path.join(home, 'broken-bin')
      await mkdir(broken)
      await writeFile(
        path.join(broken, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
        process.platform === 'win32' ? '@node "%~dp0missing-pnpm.cjs" %*\r\n' : '#!/bin/sh\nexit 1\n',
        { mode: 0o755 },
      )
      process.env.PATH = [broken, previousPath].filter(Boolean).join(path.delimiter)
      const pnpm = await resolveCompanionPackageManager()
      expect(pnpm.status).toBe('ready')
      expect(pnpm.directory).not.toBe(broken)
      const start = async (): Promise<ManagedLiveRuntime> => {
        launches += 1
        launchOutput = ''
        try {
          return await startManagedRuntime({
            dshHome: home,
            spawn: (executable, args, cwd, environment) => {
              const javascript = /\.(?:c|m)?js$/iu.test(executable)
              const child: SpawnedChild = spawnManagedChild(
                javascript ? process.execPath : executable,
                javascript ? [executable, ...args] : args,
                cwd,
                environment,
                pnpm.directory === undefined ? [] : [pnpm.directory],
              )
              return { ...child, stdout: capture(child.stdout), stderr: capture(child.stderr) }
            },
          })
        } catch (error) {
          const failures = launchOutput
            .split(/\r?\n/u)
            .filter((line) => /error|failed|cannot|missing/iu.test(line))
            .slice(-5)
            .map((line) =>
              line.replace(/https?:\/\/\S+/gu, '[url]').replace(/[A-Za-z]:[\\/][^\r\n]*/gu, '[path]'),
            )
          throw new Error(
            `Isolated DSH launch ${launches} failed; outputBytes=${launchOutput.length}; diagnostics=${JSON.stringify(failures)}`,
            { cause: error },
          )
        }
      }
      runtime = await start()
      // This harness owns the supervisor and its disposable child; direct adapter
      // construction otherwise defaults the connection descriptor to external.
      const own = (current: ManagedLiveRuntime): DshBackend => ({
        ...current.backend,
        connection: { ...current.backend.connection, ownership: 'managed' },
      })
      ownedBackend = own(runtime)
      const reconnect = async (): Promise<void> => {
        const previous = runtime
        runtime = undefined
        ownedBackend = undefined
        await previous?.stop()
        runtime = await start()
        ownedBackend = own(runtime)
      }
      manager = new EditorCompanionManagement({
        backend: () => {
          if (ownedBackend === undefined) throw new Error('Fixture disconnected')
          return ownedBackend
        },
        current: (backend) => backend === ownedBackend,
        extensionUri: FixtureUri.file(path.resolve('apps/extension')) as unknown as vscode.Uri,
        storageUri: FixtureUri.file(path.join(home, 'extension-storage')) as unknown as vscode.Uri,
        reconnect,
        active: () => false,
        enable: () => Promise.resolve(false),
        stop: () => Promise.resolve(),
        halt: () => Promise.resolve(),
        undo: () => Promise.resolve(),
        checkPackageManager: checkCompanionPackageManager,
      })
      await manager.refreshStatus(true)
      expect(manager.installationStatus).toMatchObject({ installed: false, packageManager: 'ready' })
      expect(
        await manager.installBundled({ silent: true }),
        JSON.stringify(manager.installationFailure),
      ).toBe(true)
      await manager.refreshStatus(true)
      expect(manager.installationStatus.installed).toBe(true)
      const updated = await manager.installBundled({ silent: true })
      expect(updated, JSON.stringify(manager.installationFailure)).toBe(true)
      const repository = runtime.backend.pluginBundles
      if (repository === undefined) throw new Error('Missing native plugin manager')
      const install = repository.installBundle.bind(repository)
      // A missing tarball exercises an actual pnpm failure after Host validation.
      // All subsequent calls, including automatic recovery, use the real repository.
      const fault = vi
        .spyOn(repository, 'installBundle')
        .mockImplementationOnce((_file, options, signal) =>
          install(path.join(home, 'missing-companion.tgz'), options, signal),
        )
      expect(await manager.installBundled({ silent: true })).toBe(false)
      expect(fault).toHaveBeenCalledTimes(2)
      expect(manager.busy).toBe(false)
      expect(manager.sharingBlocked).toBe(false)
      expect(native.info).toHaveBeenCalledWith(expect.stringContaining('was restored'))
      expect(JSON.stringify(native.error.mock.calls)).not.toContain('could not be confirmed')
      await manager.refreshStatus(true)
      expect(manager.installationStatus.installed).toBe(true)
      expect(
        (await runtime.backend.pluginBundles?.listBundles())?.find(
          (bundle) => bundle.name === '@dsh-vscode/editor-bridge',
        ),
      ).toMatchObject({ installed: true, version: '0.2.2' })
      console.log(
        `[dsh-live-companion-install] ${process.env.DSH_LIVE_RUNTIME_VERSION ?? 'unset'}: Host install/update/reconnect, real pnpm failure, cached rollback and final status passed`,
      )
    } finally {
      await manager?.dispose()
      await runtime?.stop()
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await rm(home, { recursive: true, force: true })
    }
  }, 300_000)
})
