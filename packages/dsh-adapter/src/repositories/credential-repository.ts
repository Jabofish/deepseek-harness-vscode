import type { CredentialRepository } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6CredentialRepository implements CredentialRepository {
  public constructor(private readonly transport: DshTransport) {}

  public setSecret(providerId: string, field: string, value: string, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('rc6 provider secret write', [
      'accept values only from Extension Host secret input, never Webview state persistence',
      'send through the official DSH credential configuration path',
      'zero or release transient references as soon as practical and redact all logs',
      'report success without echoing the value',
      `provider ${providerId}; field ${field}; value length ${value.length}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ])
  }

  public removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('rc6 provider secret removal', [
      'require explicit user action',
      'remove through the official DSH credential path',
      'refresh provider readiness after completion',
      `provider ${providerId}; field ${field}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
