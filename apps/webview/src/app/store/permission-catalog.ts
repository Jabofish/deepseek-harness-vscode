import type { PermissionPresetCatalog } from '@dsh-vscode/domain'
import { stringList } from './list-equality.js'
import { object } from './unknown-record.js'

/** Accept older Host lists while keeping the native default distinct from a user choice. */
export function parsePermissionCatalog(value: unknown): PermissionPresetCatalog | undefined {
  const catalog = object(value)
  const items = stringList(Array.isArray(value) ? value : catalog?.items)
  if (items === undefined) return undefined
  const defaultPreset = catalog?.defaultPreset
  if (defaultPreset !== undefined && (typeof defaultPreset !== 'string' || !items.includes(defaultPreset)))
    return undefined
  return { items, ...(defaultPreset === undefined ? {} : { defaultPreset }) }
}
