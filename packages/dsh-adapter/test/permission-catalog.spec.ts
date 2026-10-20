import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import {
  readPermissionCatalog,
  readPermissionCatalogSnapshot,
} from '../src/versions/alpha161/permission-catalog.js'

describe('alpha161 permission catalog contract', () => {
  function fixture(value: unknown): { remoteRequest: ReturnType<typeof vi.fn>; transport: DshTransport } {
    const remoteRequest = vi.fn().mockResolvedValue({ ok: true, value })
    return { remoteRequest, transport: { remoteRequest } as unknown as DshTransport }
  }
  it('reads the process Remote with no session argument and preserves dynamic IDs', async () => {
    const { transport, remoteRequest } = fixture({
      options: [
        { value: 'organization-safe', name: 'Safe', description: 'Restricted' },
        { value: 'auto', name: 'Auto' },
        { value: 'custom', name: 'Custom' },
      ],
    })
    const signal = new AbortController().signal
    expect(await readPermissionCatalog(transport, signal)).toEqual(['organization-safe', 'auto'])
    expect(remoteRequest).toHaveBeenCalledWith('permissionPresets/catalog', {}, signal)
  })
  it.each([
    null,
    {},
    { options: [null] },
    { options: [{ value: 'auto' }] },
    { options: [{ value: 'auto', name: 'Auto', description: 2 }] },
  ])('rejects a malformed catalog %j', async (value) => {
    await expect(readPermissionCatalog(fixture(value).transport)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
  it('preserves the native default without guessing from the first option', async () => {
    const { transport } = fixture({
      options: [
        { value: 'organization-safe', name: 'Safe' },
        { value: 'read-only', name: 'Read only' },
      ],
      defaultPreset: 'read-only',
    })
    expect(await readPermissionCatalogSnapshot(transport)).toEqual({
      items: ['organization-safe', 'read-only'],
      defaultPreset: 'read-only',
    })
  })
  it('leaves the default absent for older catalogs that do not state one', async () => {
    expect(
      await readPermissionCatalogSnapshot(fixture({ options: [{ value: 'auto', name: 'Auto' }] }).transport),
    ).toEqual({ items: ['auto'] })
  })
  it.each(['missing', '', 'custom', null, 1])(
    'rejects an invalid native default %j',
    async (defaultPreset) => {
      await expect(
        readPermissionCatalogSnapshot(
          fixture({ options: [{ value: 'safe', name: 'Safe' }], defaultPreset }).transport,
        ),
      ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    },
  )
  it.each(['CANCELLED', 'TIMEOUT', 'BACKEND_UNREACHABLE'])(
    'preserves %s without caching a stale roster',
    async (code) => {
      const { transport, remoteRequest } = fixture({ options: [] })
      remoteRequest.mockRejectedValueOnce({ code })
      await expect(readPermissionCatalog(transport)).rejects.toEqual({ code })
      expect(await readPermissionCatalog(transport)).toEqual([])
    },
  )
})
