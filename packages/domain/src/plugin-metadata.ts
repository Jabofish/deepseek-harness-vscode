/** Display-only plugin facts, with no host paths or loader configuration. */
export type PluginLocalizedText = string | Readonly<Record<string, string> & { en: string }>
export interface PluginMetadata {
  readonly title?: PluginLocalizedText
  readonly description?: PluginLocalizedText
  readonly icon?: string
  readonly error?: string
}
export function isPluginMetadata(value: unknown): value is PluginMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    (item.title === undefined || localized(item.title)) &&
    (item.description === undefined || localized(item.description)) &&
    (item.icon === undefined || typeof item.icon === 'string') &&
    (item.error === undefined || typeof item.error === 'string')
  )
}
function localized(value: unknown): value is PluginLocalizedText {
  if (typeof value === 'string') return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.en === 'string' && Object.values(item).every((text) => typeof text === 'string')
}
export function pluginLocalizedText(
  value: PluginLocalizedText | undefined,
  locale: string,
): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return value[locale.toLowerCase()] ?? value[locale.split('-')[0]!] ?? value.en
}
