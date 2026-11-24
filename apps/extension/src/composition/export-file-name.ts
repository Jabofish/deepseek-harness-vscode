/** Windows refuses these device names as a file name, with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu

/**
 * A default export file name derived from a session title. Characters no
 * common file system accepts become `-`, the length is bounded by code point
 * so an emoji is never split, and reserved Windows device names stay usable.
 */
export function exportFileBaseName(title: string): string {
  const cleaned = Array.from(title.trim(), (char) => (char.charCodeAt(0) < 32 ? '-' : char))
    .join('')
    .replace(/[<>:"/\\|?*]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  const bounded = Array.from(cleaned)
    .slice(0, 80)
    .join('')
    .replace(/[. ]+$/u, '')
  if (bounded === '') return 'dsh-session'
  return WINDOWS_RESERVED_NAME.test(bounded.split('.')[0] ?? '') ? `${bounded}-session` : bounded
}
