import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, isLoopbackEndpoint, type DshBackend } from '@dsh-vscode/domain'
import { verifyCompanionHost } from './companion-host-proof.js'

/** Read-only detection. This never installs into or restarts an external process. */
export async function companionNeedsUpdate(
  backend: DshBackend,
  resources: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
  if (!isLoopbackEndpoint(backend.connection.endpoint)) return false
  const companion = backend.editorBridge?.companion
  if (companion === undefined) return false
  const probe = AbortSignal.any([AbortSignal.timeout(2_500), ...(signal === undefined ? [] : [signal])])
  try {
    const manifest: unknown = JSON.parse(
      await readFile(path.join(resources, 'editor-companion-build.json'), 'utf8'),
    )
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('buildId' in manifest) ||
      typeof manifest.buildId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(manifest.buildId)
    )
      return false
    await companion.describe(probe)
    let installed: string | undefined
    try {
      installed = await companion.buildIdentity?.(probe)
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE')) throw error
    }
    if (installed === manifest.buildId) return false
    await verifyCompanionHost(companion, probe)
    return true
  } catch (error) {
    signal?.throwIfAborted()
    // Called only after explicit bundled-companion consent. An owned runtime
    // without the service needs a fresh start to load the user's selection.
    if (
      backend.connection.ownership === 'managed' &&
      error instanceof AppError &&
      error.code === 'CAPABILITY_UNAVAILABLE'
    )
      return true
    // Optional update detection cannot prevent a working chat connection.
    return false
  }
}
