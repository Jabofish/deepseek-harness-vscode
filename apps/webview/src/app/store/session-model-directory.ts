import type { ModelCatalogFailure, ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { object } from './unknown-record.js'
import { sameModelCatalogFailureList, sameModelDescriptorList } from './list-equality.js'
import {
  isModelCatalogFailure,
  isModelDescriptor,
  isModelSelection,
  sameModelSelection,
} from './model-catalog.js'
import type { AppState, StateSetter } from './types.js'

export interface SessionModelDirectory {
  readonly models: readonly ModelDescriptor[]
  readonly failures: readonly ModelCatalogFailure[]
  /** The route the session's next request will take, as the host states it. */
  readonly current: ModelSelection
  readonly routable: boolean
}

/** A refused read carries its reason instead of masquerading as an empty directory. */
export type SessionModelDirectoryRead =
  | { readonly ok: true; readonly directory: SessionModelDirectory }
  | { readonly ok: false; readonly message: string }

export async function loadSessionModelDirectory(
  client: ProtocolClient,
  sessionId: string,
): Promise<SessionModelDirectoryRead> {
  const malformed = translate('app.error.malformedModelDirectory')
  try {
    const result = object(
      await client.request<unknown>({
        type: 'models.session.list',
        requestId: requestId(),
        payload: { sessionId },
      }),
    )
    if (result === undefined || !Array.isArray(result.models) || !result.models.every(isModelDescriptor))
      return { ok: false, message: malformed }
    // Failures, route and routability are authoritative parts of the fragment.
    // Reject malformed metadata instead of dropping it or inferring it from rows.
    if (!Array.isArray(result.failures) || !result.failures.every(isModelCatalogFailure))
      return { ok: false, message: malformed }
    if (!isModelSelection(result.current)) return { ok: false, message: malformed }
    if (typeof result.routable !== 'boolean') return { ok: false, message: malformed }
    return {
      ok: true,
      directory: {
        models: result.models,
        failures: result.failures,
        current: result.current,
        routable: result.routable,
      },
    }
  } catch (error) {
    const message = object(error)?.message
    return {
      ok: false,
      message:
        typeof message === 'string' && message.trim() !== ''
          ? message
          : translate('app.error.hostUnspecified'),
    }
  }
}

/** Keep the last good directory on failure and ignore reads for a departed session. */
export function mergeSessionModelDirectory(
  current: AppState,
  sessionId: string,
  read: SessionModelDirectoryRead,
): AppState {
  if (current.activeSessionId !== sessionId) return current
  if (!read.ok) {
    if (!current.sessionModelDirectoryLoading && current.sessionModelDirectoryError === read.message)
      return current
    return { ...current, sessionModelDirectoryLoading: false, sessionModelDirectoryError: read.message }
  }
  const { models, failures, routable, current: selection } = read.directory
  if (
    !current.sessionModelDirectoryLoading &&
    current.sessionModelDirectoryError === undefined &&
    sameModelDescriptorList(current.sessionModels, models) &&
    sameModelCatalogFailureList(current.sessionModelFailures, failures) &&
    sameModelSelection(current.sessionModelCurrent, selection) &&
    current.sessionModelRoutable === routable
  )
    return current
  return {
    ...current,
    sessionModels: models,
    sessionModelFailures: failures,
    sessionModelCurrent: selection,
    sessionModelRoutable: routable,
    sessionModelDirectoryLoading: false,
    sessionModelDirectoryError: undefined,
  }
}

export async function refreshSessionModelDirectory(
  client: ProtocolClient,
  setState: StateSetter,
  sessionId: string,
  isCurrent: () => boolean,
): Promise<void> {
  setState((current) =>
    current.activeSessionId === sessionId && !current.sessionModelDirectoryLoading
      ? { ...current, sessionModelDirectoryLoading: true }
      : current,
  )
  const read = await loadSessionModelDirectory(client, sessionId)
  setState((current) => (isCurrent() ? mergeSessionModelDirectory(current, sessionId, read) : current))
}
