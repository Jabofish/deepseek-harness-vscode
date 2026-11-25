import { AppError, type PermissionPresetCatalog } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

/** 0.1.6 alpha keeps selectable presets outside the durable Session projection. */
export async function readPermissionCatalog(
  transport: DshTransport,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  return (await readPermissionCatalogSnapshot(transport, signal)).items
}

export async function readPermissionCatalogSnapshot(
  transport: DshTransport,
  signal?: AbortSignal,
): Promise<PermissionPresetCatalog> {
  await transport.waitForEventStreamReady?.(signal)
  const value = recordOrUndefined(
    unwrapRpcResultValue<unknown>(
      await transport.remoteRequest('permissionPresets/catalog', {}, signal),
      'permissionPresets/catalog',
    ),
  )
  const options = value?.options
  const defaultOptions = value?.defaultOptions
  if (!validOptionList(options) || (defaultOptions !== undefined && !validOptionList(defaultOptions)))
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed permission catalog.',
      retryable: false,
    })
  const items = presetIds(options)
  // Earlier catalogs publish choices only. Never infer their default from
  // option order or a built-in preset name.
  const defaultPreset = value?.defaultPreset
  if (defaultPreset !== undefined && (typeof defaultPreset !== 'string' || !items.includes(defaultPreset)))
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed default permission preset.',
      retryable: false,
    })
  // rc.5 publishes the new-session default choices separately from the
  // session choices (`defaultOptions` omits session-only Auto).
  const defaults = defaultOptions === undefined ? undefined : presetIds(defaultOptions)
  return {
    items,
    ...(defaultPreset === undefined ? {} : { defaultPreset }),
    ...(defaults === undefined ? {} : { defaultOptions: defaults }),
  }
}

function validOptionList(value: unknown): value is readonly { readonly value: string }[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      const option = recordOrUndefined(entry)
      return (
        typeof option?.value === 'string' &&
        option.value.trim() !== '' &&
        typeof option.name === 'string' &&
        (option.description === undefined || typeof option.description === 'string')
      )
    })
  )
}

function presetIds(options: readonly { readonly value: string }[]): readonly string[] {
  return [...new Set(options.map((entry) => entry.value).filter((id) => id !== 'custom'))]
}
