import type { ModelSelection, SessionDetail, TodoView } from '@dsh-vscode/domain'

import { recordOrUndefined } from '../repositories/shared/guards.js'

/** Projection of the host's permissions face into the settings UI contract. */
export function permissionPresetIds(value: unknown): readonly string[] {
  const permissions = recordOrUndefined(recordOrUndefined(value)?.permissions)
  const options = Array.isArray(permissions?.options) ? permissions.options : []
  return [
    ...new Set(
      options.flatMap((entry) => {
        const option = recordOrUndefined(entry)
        return typeof option?.value === 'string' && option.value !== '' && option.value !== 'custom'
          ? [option.value]
          : []
      }),
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
  const record = recordOrUndefined(value) ?? {}
  const status = stringOr(record.status, 'pending')
  return {
    id: stringOr(record.id, `todo:${index}`),
    content: firstString(record.content, record.title, record.text) ?? 'Todo',
    status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in-progress' : 'pending',
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
