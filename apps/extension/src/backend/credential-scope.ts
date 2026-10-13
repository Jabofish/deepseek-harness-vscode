import { randomBytes, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@dsh-vscode/domain'

/** SecretStorage lives on the client; this identity lives beside the executing Host. */
export function createCredentialScope(storageRoot: string): () => Promise<string> {
  let pending: Promise<string> | undefined
  return () => {
    pending ??= loadScope(storageRoot).catch((error: unknown) => {
      pending = undefined
      throw new AppError({
        code: 'AUTH_REQUIRED',
        message: 'The execution environment could not be identified securely. Retry the connection.',
        retryable: true,
        cause: error,
      })
    })
    return pending
  }
}

async function loadScope(storageRoot: string): Promise<string> {
  await mkdir(storageRoot, { recursive: true })
  const target = path.join(storageRoot, 'external-connection-scope')
  const stored = await readScope(target)
  if (stored !== undefined) return stored
  const candidate = path.join(storageRoot, `external-connection-scope-${randomUUID()}.tmp`)
  const scope = randomBytes(16).toString('hex')
  await writeFile(candidate, scope, { flag: 'wx', mode: 0o600 })
  try {
    // Publish a complete identity without replacing an identity another window created.
    try {
      await link(candidate, target)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    const published = await readScope(target)
    if (published === undefined) throw new Error('The environment identity is missing.')
    return published
  } finally {
    await unlink(candidate)
  }
}

async function readScope(target: string): Promise<string | undefined> {
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 32)
    throw new Error('The environment identity is invalid.')
  const scope = await readFile(target, 'utf8')
  if (!/^[a-f0-9]{32}$/u.test(scope)) throw new Error('The environment identity is invalid.')
  return scope
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
