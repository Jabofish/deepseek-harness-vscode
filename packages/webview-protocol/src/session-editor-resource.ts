/** Native Workbench editor/resource drop formats, checked against VS Code 1.125 and 1.142. */
export const SESSION_EDITOR_DRAG_MIME = 'CodeEditors'
export const SESSION_RESOURCE_DRAG_MIME = 'ResourceURLs'
export const SESSION_DROP_EDITOR_VIEW_TYPE = 'dsh.sessionDrop'
const PREFIX = 'dsh-session:/'
const SUFFIX = '.dsh-chat'

/** Explicit editor override keeps native drops out of the text-file resolver. */
export function sessionEditorDragPayload(sessionId: string): string {
  const resource = sessionEditorResource(sessionId)
  return JSON.stringify([
    {
      resource: { $mid: 1, scheme: 'dsh-session', path: resource.slice('dsh-session:'.length) },
      options: { override: SESSION_DROP_EDITOR_VIEW_TYPE, pinned: true },
    },
  ])
}

/** A synthetic editor resource containing only an opaque session ID. */
export function sessionEditorResource(sessionId: string): string {
  if (!validId(sessionId)) throw new Error('Invalid chat session ID.')
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(sessionId)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return `${PREFIX}${encoded}${SUFFIX}`
}

export function sessionIdFromEditorResource(resource: string): string | undefined {
  if (!resource.startsWith(PREFIX) || !resource.endsWith(SUFFIX) || resource.length > 1_400) return undefined
  const encoded = resource.slice(PREFIX.length, -SUFFIX.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined
  try {
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0),
    )
    const sessionId = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return validId(sessionId) && sessionEditorResource(sessionId) === resource ? sessionId : undefined
  } catch {
    return undefined
  }
}

function validId(value: string): boolean {
  return (
    value.trim() !== '' &&
    value.length <= 256 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 0x20 || code === 0x7f
    })
  )
}
