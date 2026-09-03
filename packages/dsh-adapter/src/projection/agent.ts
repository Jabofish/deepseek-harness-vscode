import type { ModelSelection, SessionDetail, TodoView } from '@dsh-vscode/domain'

import { recordOrUndefined } from '../repositories/shared/guards.js'

/** Projection of the host's permissions face into the settings UI contract. */
export function permissionPresetIds(value: unknown): readonly string[] | undefined {
  const projectionValues = recordOrUndefined(value)
  if (
    projectionValues === undefined ||
    !Object.prototype.hasOwnProperty.call(projectionValues, 'permissions')
  )
    return undefined
  const permissions = recordOrUndefined(projectionValues.permissions)
  if (permissions === undefined || !Array.isArray(permissions.options)) return []
  // Do not turn a partially malformed authoritative roster into a smaller
  // allowlist. An empty result is still present (and therefore fail-closed),
  // while `undefined` means that the host did not compose this capability.
  if (
    permissions.options.some((entry) => {
      const option = recordOrUndefined(entry)
      return typeof option?.value !== 'string' || option.value.trim() === ''
    })
  )
    return []
  return [
    ...new Set(
      permissions.options
        .map((entry) => (recordOrUndefined(entry) as { readonly value: string }).value)
        .filter((value) => value !== 'custom'),
    ),
  ]
}

export function mapConfiguration(value: unknown): SessionDetail['configuration'] {
  const record = recordOrUndefined(value) ?? {}
  return {
    preset: stringOr(record.preset, 'standard'),
    toolMode: enumValue(record.toolMode, ['native', 'ptc', 'code', 'both'] as const, 'native'),
    permissionPreset: stringOr(record.permissionPreset, 'workspace-write'),
    planMode: boolean(record.planMode, false),
    ...(typeof record.sandboxMode === 'string' ? { sandboxMode: record.sandboxMode } : {}),
    ...(typeof record.approvalPolicy === 'string' ? { approvalPolicy: record.approvalPolicy } : {}),
    model: {
      providerId: stringOr(recordOrUndefined(record.model)?.providerId, ''),
      modelId: stringOr(recordOrUndefined(record.model)?.modelId, ''),
      ...(recordOrUndefined(record.model)?.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: stringOr(recordOrUndefined(record.model)?.reasoningLevel, '') }),
    },
  }
}

export function mapModelPatch(data: Record<string, unknown>): Partial<ModelSelection> {
  const header = recordOrUndefined(data.header)
  const config = recordOrUndefined(header?.config) ?? recordOrUndefined(data.config)
  const provider = firstString(data.provider, data.providerId, config?.provider, config?.providerId)
  const model = firstString(data.model, data.modelId, config?.model, config?.modelId)
  const reasoningLevel = firstString(
    data.reasoningEffort,
    data.reasoningLevel,
    config?.reasoningEffort,
    config?.reasoningLevel,
  )
  return {
    ...(provider === undefined ? {} : { providerId: provider }),
    ...(model === undefined ? {} : { modelId: model }),
    ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
  }
}

export function mapTodo(value: unknown, index: number): TodoView {
  const record = recordOrUndefined(value)
  if (record === undefined) throw new Error('Malformed todo')
  const content = firstString(record.content, record.title, record.text)
  if (content === undefined) throw new Error('Malformed todo content')
  if (record.status !== 'pending' && record.status !== 'in_progress' && record.status !== 'completed')
    throw new Error('Malformed todo status')
  return {
    id: stringOr(record.id, `todo:${index}`),
    content,
    status:
      record.status === 'completed'
        ? 'completed'
        : record.status === 'in_progress'
          ? 'in-progress'
          : 'pending',
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && values.includes(value) ? value : fallback
}
