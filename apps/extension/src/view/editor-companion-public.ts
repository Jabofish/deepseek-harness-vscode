import {
  EDITOR_COMPANION_TOOLS,
  EDITOR_COMPANION_FAILURES,
  editorCompanionFailureMessage,
  isEditorCompanionFailure,
  isEditorCompanionValue,
  isEditorStateSnapshot,
  type EditorCompanionValue,
} from '@dsh-vscode/domain'

/** Project our tool calls before generic public recursion, for both live events and history. */
export function publicEditorCompanionTool(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (
    typeof source.name !== 'string' ||
    !Object.hasOwn(EDITOR_COMPANION_TOOLS, source.name) ||
    typeof source.id !== 'string' ||
    typeof source.status !== 'string'
  )
    return undefined
  let output =
    source.status === 'completed'
      ? 'Editor request completed.'
      : source.status === 'failed'
        ? 'Editor request failed or was denied.'
        : source.status === 'cancelled'
          ? 'Editor request cancelled.'
          : 'Editor request in progress.'
  if (source.status === 'failed') {
    const operation = EDITOR_COMPANION_TOOLS[source.name as keyof typeof EDITOR_COMPANION_TOOLS]
    for (const candidate of [source.error, source.outputSummary]) {
      if (typeof candidate !== 'string' || candidate.length > 16_384) continue
      const reason = /\[editor:([a-z-]+)\]/u.exec(candidate)?.[1]
      if (isEditorCompanionFailure(reason)) {
        output = editorCompanionFailureMessage(reason, operation)
        break
      }
      // Existing runtimes may not include the reason marker. Accept only exact fixed messages.
      const known = EDITOR_COMPANION_FAILURES.find(
        (failure) => editorCompanionFailureMessage(failure, operation) === candidate,
      )
      if (known !== undefined) {
        output = editorCompanionFailureMessage(known, operation)
        break
      }
    }
  }
  if (
    source.status === 'completed' &&
    typeof source.outputSummary === 'string' &&
    source.outputSummary.length <= 524_288
  ) {
    try {
      const value: unknown = JSON.parse(source.outputSummary)
      if (isEditorCompanionValue(value)) output = summary(value)
      else if (isEditorStateSnapshot(value))
        output = `${value.relativePath} · version ${value.documentVersion}${value.dirty ? ' · unsaved' : ''}`
    } catch {
      /* Display a fixed summary; never forward unrecognized raw tool payloads. */
    }
  }
  const result: Record<string, unknown> = {
    id: source.id,
    name: source.name,
    category: 'editor',
    title: source.name,
    status: source.status,
    inputSummary: 'Scoped editor request',
    outputSummary: output,
    metadata: {},
  }
  if (typeof source.parentCallId === 'string' && source.parentCallId.length <= 256)
    result.parentCallId = source.parentCallId
  for (const field of ['turn', 'step'])
    if (typeof source[field] === 'number' && Number.isSafeInteger(source[field]) && source[field] >= 0)
      result[field] = source[field]
  for (const field of ['startedAt', 'completedAt'])
    if (
      typeof source[field] === 'string' &&
      source[field].length <= 40 &&
      Number.isFinite(Date.parse(source[field]))
    )
      result[field] = source[field]
  return result
}
function summary(value: EditorCompanionValue): string {
  switch (value.kind) {
    case 'state':
      return `${value.state.relativePath} · version ${value.state.documentVersion}${value.state.dirty ? ' · unsaved' : ''}`
    case 'document':
      return `${value.relativePath} · version ${value.version} · ${value.text.length} characters${value.truncated ? ' · truncated' : ''}`
    case 'diagnostics':
      return `${value.relativePath} · ${value.items.length} cached diagnostics${value.truncated ? ' · truncated' : ''}`
    case 'symbols':
      return `${value.items.length} symbols${value.truncated ? ' · truncated' : ''} · ${value.excluded} out-of-scope results excluded`
    case 'locations':
      return `${value.items.length} locations${value.truncated ? ' · truncated' : ''} · ${value.excluded} out-of-scope results excluded`
    case 'opened':
      return `Opened ${value.relativePath}`
    case 'proposal':
      return `${value.relativePath} · edit proposal ${value.status} · version ${value.version}${value.saved === true ? ' · saved' : value.saved === false ? ' · save incomplete' : ''}`
  }
}
