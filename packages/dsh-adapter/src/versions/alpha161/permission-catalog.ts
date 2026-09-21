import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

/** 0.1.6 alpha keeps selectable presets outside the durable Session projection. */
export async function readPermissionCatalog(
  transport: DshTransport,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const value = recordOrUndefined(
    unwrapRpcResultValue<unknown>(
      await transport.remoteRequest('permissionPresets/catalog', {}, signal),
      'permissionPresets/catalog',
    ),
  )
  const options = value?.options
  if (
    !Array.isArray(options) ||
    options.some((entry) => {
      const option = recordOrUndefined(entry)
      return (
        typeof option?.value !== 'string' ||
        option.value.trim() === '' ||
        typeof option.name !== 'string' ||
        (option.description !== undefined && typeof option.description !== 'string')
      )
    })
  )
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed permission catalog.',
      retryable: false,
    })
  return [...new Set(options.map((entry: { value: string }) => entry.value).filter((id) => id !== 'custom'))]
}
