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
})
