import type { SkillDescriptor, SkillRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'

export class Rc6SkillRepository implements SkillRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    if (sessionId === undefined || sessionId.trim() === '')
      throw unavailable('skill list without a session context')
    const value = await callRpc<{ skills: unknown[] }>(this.transport, 'skill.list', { sessionId }, signal)
    return (Array.isArray(value.skills) ? value.skills : []).flatMap((entry) => {
      const record = asRecord(entry)
      if (typeof record.name !== 'string') return []
      return [
        {
          id: record.name,
          name: record.name,
          description: typeof record.description === 'string' ? record.description : '',
          source: 'project' as const,
          enabled: record.modelInvocable !== false,
        },
      ]
    })
  }

  public refresh(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    return this.list(sessionId, signal)
  }

  public async execute(
    sessionId: string,
    skillId: string,
    input: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await callRpc(
      this.transport,
      'session.prompt',
      {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `/${skillId}${input.length === 0 ? '' : ` ${input}`}` }],
      },
      signal,
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
