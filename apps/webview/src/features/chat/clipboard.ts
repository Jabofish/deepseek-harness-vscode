/** Copy text through the Webview clipboard API with a DOM fallback. */
export async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard?.writeText !== undefined) {
    await clipboard.writeText(text)
    return true
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
