import type { AgentPresetDescriptor } from '@dsh-vscode/domain'
import type { Translate } from '../../i18n.js'

export type BuiltInPresetId = 'standard' | 'ptc' | 'minimal' | 'cordis'

export function builtInPresetId(row: AgentPresetDescriptor): BuiltInPresetId | undefined {
  if (row.trust !== 'system') return undefined
  switch (row.id) {
    case 'standard':
    case 'ptc':
    case 'minimal':
    case 'cordis':
      return row.id
    default:
      return undefined
  }
}

export function presetDisplayName(row: AgentPresetDescriptor, t: Translate): string {
  if (row.name !== undefined && row.name.trim() !== '') return row.name
  const builtIn = builtInPresetId(row)
  return builtIn === undefined ? row.id : t(`presets.builtin.${builtIn}.name`)
}

export function presetDisplayDescription(row: AgentPresetDescriptor, t: Translate): string {
  if (row.description !== undefined && row.description.trim() !== '') return row.description
  const builtIn = builtInPresetId(row)
  return builtIn === undefined ? t('presets.noDescription') : t(`presets.builtin.${builtIn}.description`)
}
