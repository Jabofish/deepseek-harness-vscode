import type { DshUpdateSnapshot } from '@dsh-vscode/domain'

import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { parseDshUpdateSnapshot } from './host-settings.js'
import type { StateSetter } from './types.js'

/**
 * Runtime update checks and installs share one progress convention: flip the
 * progress phase first, then publish the snapshot only when DSH returned one.
 * A failed check leaves the progress row on screen for the error path to
 * settle.
 */
export function createDshUpdateActions({
  client,
  setState,
}: {
  client: ProtocolClient
  setState: StateSetter
}): {
  checkDshUpdates: (force?: boolean) => Promise<DshUpdateSnapshot | undefined>
  installDshVersion: (version: string) => Promise<DshUpdateSnapshot | undefined>
} {
  const checkDshUpdates = async (force = false): Promise<DshUpdateSnapshot | undefined> => {
    setState((current) => ({
      ...current,
      dshUpdateProgress: { phase: 'checking' },
    }))
    const snapshot = parseDshUpdateSnapshot(
      await client.request<unknown>({
        type: 'runtime.update.check',
        requestId: requestId(),
        payload: { force },
      }),
    )
    if (snapshot !== undefined) setState((current) => ({ ...current, dshUpdate: snapshot }))
    return snapshot
  }
  const installDshVersion = async (version: string): Promise<DshUpdateSnapshot | undefined> => {
    setState((current) => ({
      ...current,
      dshUpdateProgress: { phase: 'checking', version },
    }))
    const snapshot = parseDshUpdateSnapshot(
      await client.request<unknown>({
        type: 'runtime.update.install',
        requestId: requestId(),
        payload: { version },
      }),
    )
    if (snapshot !== undefined) setState((current) => ({ ...current, dshUpdate: snapshot }))
    return snapshot
  }
  return { checkDshUpdates, installDshVersion }
}
