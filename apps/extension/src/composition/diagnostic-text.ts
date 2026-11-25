// An absolute path starts the text or follows a character that cannot be part of a path.
const ABSOLUTE_PATH =
  /(?<![\w.~\-\\/])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/)(?:[^\s'"`<>|:()[\]{}]+[\\/])*[^\s'"`<>|:()[\]{}\\/]+/gu

/**
 * Diagnostic messages often quote host paths ("Cannot find module
 * '/home/me/app/src/x'"). Text that reaches the Webview must not carry them:
 * paths inside a workspace folder become workspace-relative, and any other
 * absolute path keeps only its file name.
 */
export function workspaceSafeDiagnosticText(message: string, roots: readonly string[]): string {
  let text = message
  for (const root of [...roots].sort((left, right) => right.length - left.length)) {
    const trimmed = root.replace(/[\\/]+$/u, '')
    if (trimmed === '') continue
    for (const spelling of new Set([trimmed, trimmed.replaceAll('\\', '/')])) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      text = text.replace(new RegExp(`${escaped}[\\\\/]`, 'giu'), '')
    }
  }
  return text.replace(ABSOLUTE_PATH, (match) => {
    const name = match
      .split(/[\\/]/u)
      .filter((part) => part !== '')
      .at(-1)
    return name === undefined ? match : `…/${name}`
  })
}
