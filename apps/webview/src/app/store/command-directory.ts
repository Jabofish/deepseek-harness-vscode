import type { DynamicCommand, SkillDescriptor } from '@dsh-vscode/domain'
import { MOVETO_COMMAND_NAME, movetoCommandRow } from '../client-commands.js'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { isRecord, object } from './unknown-record.js'
import { strictListValues } from './list-equality.js'

export async function readCommandList(
  client: ProtocolClient,
  sessionId: string,
): Promise<readonly DynamicCommand[] | undefined> {
  const [commandsResult, skillsResult] = await Promise.allSettled([
    client.request<unknown>({
      type: 'command.list',
      requestId: requestId(),
      payload: { sessionId },
    }),
    client.request<unknown>({
      type: 'skill.list',
      requestId: requestId(),
      payload: { sessionId },
    }),
  ])
  if (commandsResult.status === 'rejected' && skillsResult.status === 'rejected') {
    // A registry refresh is advisory. Keep the last known directory when a
    // transient connection failure occurs during commands/change handling.
    return undefined
  }
  const commands =
    commandsResult.status === 'fulfilled'
      ? strictListValues(commandsResult.value, isDynamicCommand)
      : ([] as readonly DynamicCommand[])
  const skills =
    skillsResult.status === 'fulfilled'
      ? strictListValues(skillsResult.value, isSkillDescriptor)
      : ([] as readonly SkillDescriptor[])
  // Each fulfilled endpoint returned a complete directory fragment. A
  // malformed fragment must not be reduced to an empty/partial fragment and
  // merged into the other one; preserve the last complete directory instead.
  if (
    (commandsResult.status === 'fulfilled' && commands === undefined) ||
    (skillsResult.status === 'fulfilled' && skills === undefined)
  )
    return undefined
  if (commands === undefined || skills === undefined) return undefined
  return withClientCommandContributions(mergeSkillCommands(commands, skills))
}

export function mergeSkillCommands(
  commands: readonly DynamicCommand[],
  skills: readonly SkillDescriptor[],
): readonly DynamicCommand[] {
  const names = new Set(commands.map((command) => command.name.toLocaleLowerCase()))
  const skillCommands = skills.flatMap((skill) => {
    const name = skill.name.trim()
    const key = name.toLocaleLowerCase()
    if (name === '' || names.has(key)) return []
    names.add(key)
    return [
      {
        name,
        description: skill.enabled
          ? skill.description
          : `${translate('commands.skillUserOnly')} · ${skill.description}`,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: 'skill' as const,
        ...(skill.hasDocument === true ? { hasDocument: true } : {}),
      },
    ]
  })
  return [...commands, ...skillCommands]
}

export function withClientCommandContributions(
  commands: readonly DynamicCommand[],
): readonly DynamicCommand[] {
  const contributions: DynamicCommand[] = []
  if (!commands.some((command) => command.name === 'model'))
    contributions.push({
      name: 'model',
      description: translate('commands.modelDescription'),
      source: 'plugin',
    })
  // The palette and Enter adjudication only claim a line whose row exists, so
  // the client-owned move command has to be advertised like any other.
  if (!commands.some((command) => command.name === MOVETO_COMMAND_NAME))
    contributions.push(movetoCommandRow())
  return contributions.length === 0 ? commands : [...commands, ...contributions]
}

export function isCommandDirectoryRefresh(value: unknown): boolean {
  const name = object(value)?.name
  return name === 'commands/change' || name === 'agent-preset/selected'
}

/**
 * DSH rc.1 renamed credential invalidation to a reference-scoped event and
 * also publishes owner events when adapter topology or settings documents
 * change. The official model/settings surfaces refresh their catalog in all
 * three cases; keep the Webview's cached provider/model directory coherent
 * without exposing credentials or making the Webview call DSH directly.
 */
export function isModelCatalogRefresh(value: unknown): boolean {
  const name = object(value)?.name
  return (
    // rc.6–rc.8 used the broader invalidation name; rc.1 narrowed it to a
    // reference-scoped event. Accept both so an older connected DSH keeps the
    // settings/model cache live after a credential change.
    name === 'credentials/updated' ||
    name === 'credentials/reference-updated' ||
    name === 'credentials/record-updated' ||
    name === 'llm/adapters-updated' ||
    name === 'settings/document-updated'
  )
}

export function isDynamicCommand(value: unknown): value is DynamicCommand {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.name === 'string' &&
    /^[a-z][a-z0-9_-]*$/u.test(item.name) &&
    typeof item.description === 'string' &&
    (item.whenToUse === undefined || typeof item.whenToUse === 'string') &&
    (item.input === undefined ||
      (isRecord(item.input) &&
        typeof item.input.hint === 'string' &&
        (item.input.images === undefined || typeof item.input.images === 'boolean'))) &&
    (item.source === undefined ||
      item.source === 'builtin' ||
      item.source === 'skill' ||
      item.source === 'plugin')
  )
}

export function isSkillDescriptor(value: unknown): value is SkillDescriptor {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.name === 'string' &&
    item.name.trim() !== '' &&
    typeof item.description === 'string' &&
    (item.hasDocument === undefined || typeof item.hasDocument === 'boolean') &&
    (item.whenToUse === undefined || typeof item.whenToUse === 'string') &&
    (item.source === undefined ||
      item.source === 'project' ||
      item.source === 'user' ||
      item.source === 'plugin') &&
    typeof item.enabled === 'boolean'
  )
}

export interface CommandDirectoryCache {
  load(sessionId: string, force?: boolean): Promise<readonly DynamicCommand[] | undefined>
  /** Cached entry without triggering a load, for read-only fallbacks. */
  peek(sessionId: string): readonly DynamicCommand[] | undefined
  /** Drop every cached and in-flight entry; pending loads resolve to undefined. */
  invalidate(): void
}

/**
 * Command directories are per-session reads that outlive single requests:
 * snapshots and reconnects invalidate the whole set while an open path may
 * only need one entry. Generation-stamp the loads so a refresh issued before
 * an invalidation cannot repopulate stale commands afterwards.
 */
export function createCommandDirectoryCache(
  fetch: (sessionId: string) => Promise<readonly DynamicCommand[] | undefined>,
): CommandDirectoryCache {
  let generation = 0
  const cache = new Map<string, readonly DynamicCommand[]>()
  const loads = new Map<string, Promise<readonly DynamicCommand[] | undefined>>()
  return {
    peek(sessionId) {
      return cache.get(sessionId)
    },
    invalidate(): void {
      generation += 1
      cache.clear()
      loads.clear()
    },
    load(sessionId, force = false) {
      if (force) {
        cache.delete(sessionId)
        // A live registry invalidation needs a read issued after the event,
        // rather than reusing a pending snapshot from before the change.
        loads.delete(sessionId)
      } else {
        const cached = cache.get(sessionId)
        if (cached !== undefined) return Promise.resolve(cached)
      }
      const pending = loads.get(sessionId)
      if (pending !== undefined) return pending
      const stamped = generation
      const load = fetch(sessionId)
        .then((commands) => {
          if (commands === undefined || stamped !== generation || loads.get(sessionId) !== load)
            return undefined
          cache.set(sessionId, commands)
          return commands
        })
        .finally(() => {
          if (loads.get(sessionId) === load) loads.delete(sessionId)
        })
      loads.set(sessionId, load)
      return load
    },
  }
}
