/** Copy text through the Webview clipboard API with a DOM fallback. */
export async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard?.writeText !== undefined) {
    // A Webview whose frame policy denies `clipboard-write` still exposes the
    // API, but every write rejects with NotAllowedError. Treat that as "the
    // API is unusable" and continue to the DOM fallback instead of rejecting,
    // so callers never have to guard a copy that silently did nothing.
    const written = await clipboard.writeText(text).then(
      () => true,
      () => false,
    )
    if (written) return true
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
