import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EditorCompanionError, type EditorCompanionRepository } from '@dsh-vscode/domain'

/** A forwarded loopback address or matching cwd alone does not prove a shared filesystem. */
export async function verifyCompanionHost(
  repository: EditorCompanionRepository,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const nonce = randomUUID()
  const directory = path.join(os.tmpdir(), `dsh-editor-peer-${nonce}`)
  const challenge = randomBytes(32)
  await mkdir(directory, { mode: 0o700 })
  try {
    await writeFile(path.join(directory, 'proof'), challenge, { mode: 0o600, flag: 'wx' })
    const response = await repository.verifyHost(nonce, AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
    signal.throwIfAborted()
    if (response.proof !== createHash('sha256').update(challenge).digest('hex'))
      throw new EditorCompanionError('workspace-mismatch')
  } finally {
    // This exact, newly created directory is the only cleanup target.
    await rm(directory, { recursive: true, force: true })
  }
}
