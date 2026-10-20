import { AppError, type DshBackend, type SubagentCatalog } from '@dsh-vscode/domain'

/** Stop active work through owned session/subagent ports, retaining pending input. */
export async function cancelSessionTree(
  backend: DshBackend,
  sessionId: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const assertCurrent = (): void => {
    signal?.throwIfAborted()
    if (!isCurrent())
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'The DSH connection changed during the stop request.',
        retryable: true,
      })
  }
  assertCurrent()
  // Signal the main turn first; a catalog read must never delay its stop.
  let rootFailure: { readonly error: unknown } | undefined
  try {
    await backend.sessions.cancel(sessionId, signal)
  } catch (error) {
    rootFailure = { error }
  }
  assertCurrent()
  let failed = 0
  const pending = [sessionId]
  const visited = new Set(pending)
  while (pending.length > 0 && typeof backend.subagents?.list === 'function') {
    assertCurrent()
    const parentId = pending.shift()
    if (parentId === undefined) break
    let catalog: SubagentCatalog
    try {
      catalog = await backend.subagents.list(parentId, signal)
    } catch (error) {
      assertCurrent()
      // Older compositions without the subagent capability still support Stop.
      if (parentId !== sessionId || !(error instanceof AppError) || error.code !== 'CAPABILITY_UNAVAILABLE')
        failed += 1
      continue
    }
    assertCurrent()
    for (const child of catalog.entries) {
      assertCurrent()
      if (child.kind !== 'child') {
        failed += 1
        continue
      }
      if (child.parentSessionId !== parentId || visited.has(child.id)) {
        failed += 1
        continue
      }
      visited.add(child.id)
      if (child.activity === 'running') {
        if (child.mode !== 'continuable') failed += 1
        else {
          try {
            await backend.subagents.interrupt(child.id, signal)
          } catch {
            assertCurrent()
            failed += 1
          }
        }
      }
      // Interrupt parks the current child turn but preserves its descendants.
      // Visit even idle parents, whose own children can still be active.
      if (child.hasChildren && child.mode !== 'external') pending.push(child.id)
    }
  }
  assertCurrent()
  if (rootFailure !== undefined) throw rootFailure.error
  if (failed > 0)
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message:
        'The session stop was sent, but some subagent work could not be stopped. Check the subagent controls in this conversation and retry.',
      retryable: true,
    })
}
