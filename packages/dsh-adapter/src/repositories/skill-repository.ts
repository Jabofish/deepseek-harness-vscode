import { AppError, type SkillDescriptor, type SkillRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'

export class Rc6SkillRepository implements SkillRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId?: string, signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    // The catalog is read per session, so a missing session is a caller-context
    // gap. The refusal must not read as a capability the host turned out to lack.
    if (sessionId === undefined || sessionId.trim() === '')
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Skill list requires a session context.',
        retryable: false,
      })
    const value = asRecord(await callRpc<unknown>(this.transport, 'skill.list', { sessionId }, signal))
    if (value === undefined || !Array.isArray(value.skills)) throw malformedSkillResponse('list')
    return value.skills.flatMap((entry) => {
      const record = asRecord(entry)
      if (
        record === undefined ||
        typeof record.name !== 'string' ||
        record.name.trim() === '' ||
        typeof record.description !== 'string' ||
        (record.path !== undefined && (typeof record.path !== 'string' || record.path.trim() === '')) ||
        (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') ||
        typeof record.modelInvocable !== 'boolean'
      )
        throw malformedSkillResponse('list entry')
      return [
        {
          id: record.name,
          name: record.name,
          description: record.description,
          ...(typeof record.path === 'string' ? { documentPath: record.path } : {}),
          ...(typeof record.whenToUse === 'string' ? { whenToUse: record.whenToUse } : {}),
          // The catalog carries no origin, and `modelInvocable: false` marks a
          // skill only a human may run — the host already filtered out the ones
          // the user cannot invoke, so it stays usable here.
          enabled: record.modelInvocable,
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
    const value = asRecord(
      await callRpc<unknown>(
        this.transport,
        'session.prompt',
        {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `/${skillId}${input.length === 0 ? '' : ` ${input}`}` }],
        },
        signal,
      ),
    )
    if (value?.accepted !== true) throw malformedSkillResponse('prompt receipt')
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformedSkillResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed skill ${part} response.`,
    retryable: false,
  })
}
