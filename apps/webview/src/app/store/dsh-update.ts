import type { DshUpdateSnapshot } from '@dsh-vscode/domain'

import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { parseDshUpdateSnapshot } from './host-settings.js'
import type { StateSetter } from './types.js'

/** Ignore obsolete reads and serialize mutations of the shared installation. */
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
  let revision = 0
  let installation: { version: string; operation: Promise<DshUpdateSnapshot | undefined> } | undefined
  const publish = (snapshot: DshUpdateSnapshot, currentRevision: number): void => {
    if (currentRevision !== revision) return
    setState((current) => {
      const currentVersion = current.connectedDshVersion ?? snapshot.currentVersion
      return {
        ...current,
        dshUpdate: {
          ...snapshot,
          ...(currentVersion === undefined ? {} : { currentVersion }),
          ...(currentVersion !== undefined && snapshot.globalVersion !== undefined
            ? { restartRequired: currentVersion !== snapshot.globalVersion }
            : {}),
        },
        dshUpdateProgress: {
          ...current.dshUpdateProgress,
          phase: snapshot.status === 'ready' ? 'completed' : 'failed',
        },
      }
    })
  }
  const checkDshUpdates = async (force = false): Promise<DshUpdateSnapshot | undefined> => {
    if (installation !== undefined) return installation.operation
    const currentRevision = ++revision
    setState((current) => ({
      ...current,
      dshUpdateProgress: { phase: 'checking' },
    }))
    try {
      const snapshot = parseDshUpdateSnapshot(
        await client.request<unknown>({
          type: 'runtime.update.check',
          requestId: requestId(),
          payload: { force },
        }),
      )
      if (snapshot === undefined) throw new Error('DSH returned an invalid update status. Check again.')
      publish(snapshot, currentRevision)
      return snapshot
    } catch (error) {
      if (currentRevision === revision)
        setState((current) => ({ ...current, dshUpdate: undefined, dshUpdateProgress: { phase: 'failed' } }))
      throw error
    }
  }
  const runInstall = async (version: string): Promise<DshUpdateSnapshot | undefined> => {
    const currentRevision = ++revision
    setState((current) => ({
      ...current,
      dshUpdateProgress: { phase: 'checking', version, startedAt: Date.now() },
    }))
    try {
      const snapshot = parseDshUpdateSnapshot(
        await client.request<unknown>({
          type: 'runtime.update.install',
          requestId: requestId(),
          payload: { version },
        }),
      )
      if (snapshot === undefined)
        throw new Error('DSH returned an invalid installation status. Check again before retrying.')
      publish(snapshot, currentRevision)
      return snapshot
    } catch (error) {
      if (currentRevision === revision)
        setState((current) => ({
          ...current,
          dshUpdate: undefined,
          dshUpdateProgress: { phase: 'failed', version },
        }))
      throw error
    }
  }
  const installDshVersion = (version: string): Promise<DshUpdateSnapshot | undefined> => {
    if (installation !== undefined)
      return installation.version === version
        ? installation.operation
        : Promise.reject(new Error('A DSH installation is already running.'))
    const operation = runInstall(version)
    installation = { version, operation }
    const release = (): void => {
      if (installation?.operation === operation) installation = undefined
    }
    void operation.then(release, release)
    return operation
  }
  return { checkDshUpdates, installDshVersion }
}
