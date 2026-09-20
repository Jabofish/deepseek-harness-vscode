import path from 'node:path'
import { AppError, type SkillDescriptor } from '@dsh-vscode/domain'

/** Only local provider-advertised instruction files are native editor targets. */
export function isSkillDocumentPath(value: string): boolean {
  return path.isAbsolute(value) && !/^[\\/]{2}/u.test(value) && !value.includes('\0')
}

/** Public catalog carries a capability hint, never the provider's filesystem location. */
export function publicSkills(
  skills: readonly SkillDescriptor[],
): readonly Omit<SkillDescriptor, 'documentPath'>[] {
  return skills.map(({ documentPath, hasDocument: _hasDocument, ...skill }) => ({
    ...skill,
    ...(documentPath !== undefined && isSkillDocumentPath(documentPath) ? { hasDocument: true } : {}),
  }))
}

export async function openSkillDocument(
  documentPath: string,
  open: (documentPath: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (!isSkillDocumentPath(documentPath))
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This skill has no local documentation available.',
      retryable: false,
    })
  await open(documentPath, signal)
}
