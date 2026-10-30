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

  const previousFocus = document.activeElement
  const selection = window.getSelection()
  const ranges =
    selection === null
      ? []
      : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
  const textarea = document.createElement('textarea')
  textarea.setAttribute('data-dsh-clipboard-fallback', '')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  // In Chromium this also focuses the textarea, so the copy event this raises
  // stays owned by this payload: `useTranscriptCopyFallback` reads the focused
  // element to tell a focused text field from an addressed transcript row.
  textarea.focus({ preventScroll: true })
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    const stillOwnsFocus = document.activeElement === textarea
    textarea.remove()
    // A copy event may intentionally move focus elsewhere. Restore only the
    // temporary textarea's focus, never a newer choice made by that handler.
    if (stillOwnsFocus) {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true })
      if (selection !== null) {
        selection.removeAllRanges()
        for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range)
      }
    }
  }
}
