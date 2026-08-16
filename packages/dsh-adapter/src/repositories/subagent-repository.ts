import type { SubagentHistoryPage, SubagentRepository, SubagentView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'

export class Rc6SubagentRepository implements SubagentRepository {
  private readonly addresses = new Map<
    string,
    { readonly parentSessionId: string; readonly mode: 'one-shot' | 'continuable' }
  >()
  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly SubagentView[]> {
    const value = await callRpc<{ entries: unknown[] }>(
      this.transport,
      'subagent.list',
      { parentSessionId: sessionId },
      signal,
    )
    return value.entries.flatMap((entry) => {
      const record = asRecord(entry)
      if (record.kind !== 'child' || typeof record.id !== 'string') return []
      const mode = record.mode === 'continuable' ? 'continuable' : 'one-shot'
      this.addresses.set(record.id, { parentSessionId: sessionId, mode })
      return [
        {
          id: record.id,
          label: typeof record.label === 'string' ? record.label : 'Subagent',
          status: record.activity === 'running' ? 'running' : 'idle',
          parentSessionId: sessionId,
        },
      ]
    })
  }

  public async send(sessionId: string, message: string, signal?: AbortSignal): Promise<void> {
    const address = this.addresses.get(sessionId)
    if (address?.mode !== 'continuable') throw unavailable('one-shot subagent follow-up')
    await callRpc(
      this.transport,
      'subagent.prompt',
      {
        parentSessionId: address.parentSessionId,
        childSessionId: sessionId,
        mode: address.mode,
        content: [{ type: 'text', text: message }],
      },
      signal,
    )
  }

  public async history(sessionId: string, signal?: AbortSignal): Promise<SubagentHistoryPage> {
    const address = this.addresses.get(sessionId)
    if (address === undefined) throw unavailable('subagent history without a current catalog entry')
    const value = await callRpc<{ events: unknown[]; hasMore: boolean }>(
      this.transport,
      'subagent.history',
      {
        parentSessionId: address.parentSessionId,
        childSessionId: sessionId,
        mode: address.mode,
        maxMessages: 200,
      },
      signal,
    )
    const mapped = rc6Mapper.history(value, sessionId)
    return { events: mapped.events, hasMore: mapped.hasMore }
  }

  public async interrupt(sessionId: string, signal?: AbortSignal): Promise<void> {
    const address = this.addresses.get(sessionId)
    if (address?.mode !== 'continuable') throw unavailable('one-shot subagent interrupt')
    await callRpc(
      this.transport,
      'subagent.interrupt',
      { parentSessionId: address.parentSessionId, childSessionId: sessionId, mode: address.mode },
      signal,
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
