import type {
  DynamicCommand,
  ModelCatalogFailure,
  ModelDescriptor,
  ModelSelection,
  SkillDescriptor,
} from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { isRecord, object } from './unknown-record.js'
import { sameModelCatalogFailureList, sameModelDescriptorList, strictListValues } from './list-equality.js'
import {
  isModelCatalogFailure,
  isModelDescriptor,
  isModelSelection,
  sameModelSelection,
} from './model-catalog.js'
import type { AppState, StateSetter } from './types.js'

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

export interface SessionModelDirectory {
  readonly models: readonly ModelDescriptor[]
  readonly failures: readonly ModelCatalogFailure[]
  /** The route the session's next request will take, as the host states it. */
  readonly current: ModelSelection
  readonly routable: boolean
}

/**
 * One session-directory read. A read that could not answer carries the reason
 * the seat states: the host's own message for a refused request, or the shape
 * violation when the response cannot be read at all. Swallowing either leaves
 * the composer showing the global catalog as if it were the session's own
 * directory, with no way to ask again.
 */
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
    // The failures are half the directory: they are the only statement about
    // the providers that could not enumerate, so a row this side cannot read
    // invalidates the fragment rather than being dropped from it.
    if (!Array.isArray(result.failures) || !result.failures.every(isModelCatalogFailure))
      return { ok: false, message: malformed }
    // The route the next request will take is the directory's own statement
    // about this session; the configuration only names what someone chose. A
    // fragment without it cannot say what the seat should state, so it is
    // refused rather than left to look like an unstated selection.
    if (!isModelSelection(result.current)) return { ok: false, message: malformed }
    // `routable` is the whole-fragment verdict and the host types it as
    // required; a fragment without it cannot say whether input is legal, so it
    // is refused rather than guessed (a guess would either lock a usable
    // composer or unlock one the host will refuse).
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
    return { ok: false, message: errorText(error) }
  }
}

export function errorText(error: unknown): string {
  const message = object(error)?.message
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : translate('app.error.hostUnspecified')
}

/**
 * Fold one read into the state. A failed read keeps the last good directory —
 * the open flow has the same contract, and the picker's warning and model rows
 * must not be replaced by an empty directory the host never stated — but the
 * failure itself is published so the seat can explain the missing rows.
 */
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

/**
 * Re-read one session's model directory. This is also the seat's retry after a
 * refused read, so it has to be callable on demand and stateful while it runs.
 */
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

export function withClientCommandContributions(
  commands: readonly DynamicCommand[],
): readonly DynamicCommand[] {
  if (commands.some((command) => command.name === 'model')) return commands
  return [
    ...commands,
    {
      name: 'model',
      description: translate('commands.modelDescription'),
      source: 'plugin',
    },
  ]
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
