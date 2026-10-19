import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, type DshBackend } from '@dsh-vscode/domain'
import { companionNeedsUpdate } from './companion-update.js'

const proof = vi.hoisted(() => vi.fn())
vi.mock('./companion-host-proof.js', () => ({ verifyCompanionHost: proof }))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{
  root: string
  backend: DshBackend
  identity: ReturnType<typeof vi.fn>
  describeCompanion: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-update-test-'))
  roots.push(root)
  await writeFile(path.join(root, 'editor-companion-build.json'), JSON.stringify({ buildId: 'a'.repeat(64) }))
  const identity = vi.fn().mockResolvedValue('a'.repeat(64))
  const describeCompanion = vi.fn().mockResolvedValue({ protocolVersion: 2 })
  return {
    root,
    identity,
    describeCompanion,
    backend: {
      connection: {
        endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' },
        ownership: 'external',
      },
      editorBridge: {
        companion: { describe: describeCompanion, buildIdentity: identity },
      },
    } as unknown as DshBackend,
  }
}
describe('automatic companion update detection', () => {
  it('loads a missing companion after consent only for an owned runtime, never an external target', async () => {
    const { root, backend, describeCompanion } = await fixture()
    describeCompanion.mockRejectedValue(
      new AppError({ code: 'CAPABILITY_UNAVAILABLE', message: 'Missing companion', retryable: false }),
    )
    expect(await companionNeedsUpdate(backend, root)).toBe(false)
    const managed = { ...backend, connection: { ...backend.connection, ownership: 'managed' as const } }
    expect(await companionNeedsUpdate(managed, root)).toBe(true)
    expect(proof).not.toHaveBeenCalled()
  })
  it('compares build content rather than package version and verifies the same host before switching', async () => {
    const { root, backend, identity } = await fixture()
    expect(await companionNeedsUpdate(backend, root)).toBe(false)
    expect(proof).not.toHaveBeenCalled()
    identity.mockResolvedValue('b'.repeat(64))
    expect(await companionNeedsUpdate(backend, root)).toBe(true)
    expect(proof).toHaveBeenCalledOnce()
    identity.mockRejectedValue(
      new AppError({ code: 'CAPABILITY_UNAVAILABLE', message: 'Old companion', retryable: false }),
    )
    expect(await companionNeedsUpdate(backend, root)).toBe(true)
    proof.mockRejectedValue(new Error('different host'))
    expect(await companionNeedsUpdate(backend, root)).toBe(false)
  })
  it('keeps chat usable for missing manifests, malformed replies and cancelled detection', async () => {
    const { root, backend, identity } = await fixture()
    identity.mockRejectedValue(
      new AppError({ code: 'PROTOCOL_ERROR', message: 'Malformed build', retryable: false }),
    )
    expect(await companionNeedsUpdate(backend, root)).toBe(false)
    expect(await companionNeedsUpdate(backend, path.join(root, 'missing'))).toBe(false)
    await writeFile(path.join(root, 'editor-companion-build.json'), '{"buildId":42}')
    expect(await companionNeedsUpdate(backend, root)).toBe(false)
    await expect(companionNeedsUpdate(backend, root, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(proof).not.toHaveBeenCalled()
  })
})
