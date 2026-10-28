import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { AppError } from '@dsh-vscode/domain'
import { DSH_PACKAGE_NAME, isDshPackageVersion } from '@dsh-vscode/dsh-adapter'
import type { RuntimeCommandOptions, RuntimeCommandResult } from './update-runtime.js'
import { resolveWindowsShim, type WindowsShimResolutionOptions } from '../backend/windows-shim.js'
import { streamRuntimeCommand } from './runtime-command.js'
import { findWindowsLockOwners } from '../backend/windows-lock-owners.js'

const shims = ['dsh', 'dsh.cmd', 'dsh.ps1'] as const
const packagePath = path.join('node_modules', '@deepseek-ai', 'dsh')
const transactionName = '.dsh-vscode-update'
interface Journal {
  readonly previousPackage: boolean
  readonly previousShims: readonly boolean[]
  readonly committed: boolean
}
interface Dependencies {
  readonly execute: (args: readonly string[], options: RuntimeCommandOptions) => Promise<RuntimeCommandResult>
  readonly verify: (shim: string, version: string) => Promise<void>
}

export async function verifyWindowsRuntime(
  shim: string,
  version: string,
  environment: NodeJS.ProcessEnv,
  shimOptions: WindowsShimResolutionOptions = {},
): Promise<void> {
  const cli = resolveWindowsShim(shim, 'windows', (file) => readFileSync(file, 'utf8'), shimOptions)
  if (cli === undefined) throw installationError('The installed DSH launcher could not be verified.')
  const target = cli.prefixArgs[0] ?? cli.executable
  const relative = path.relative(path.join(path.dirname(shim), packagePath), target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw installationError('The installed DSH launcher points outside its package.')
  const probe = await streamRuntimeCommand(cli.executable, [...cli.prefixArgs, '--version'], {
    cwd: homedir(),
    env: environment,
    timeout: 15_000,
    maxBuffer: 32_768,
  })
  if (
    !probe.stdout.split(/\r?\n/u).some((line) => line.trim() === version || line.trim() === `dsh ${version}`)
  )
    throw installationError('The installed DSH executable reported an unexpected version.')
}

/** npm only sees an empty prefix. Never let Arborist retire the live Windows tree. */
export async function installWindowsRuntime(
  args: readonly string[],
  options: RuntimeCommandOptions,
  dependencies: Dependencies,
): Promise<RuntimeCommandResult> {
  const result = await dependencies.execute(['prefix', '--global'], {
    ...options,
    timeout: Math.min(options.timeout, 15_000),
    maxBuffer: 32_768,
  })
  const prefix = result.stdout.trim()
  if (
    !path.isAbsolute(prefix) ||
    /[\r\n\0]/u.test(prefix) ||
    (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(prefix))
  )
    throw installationError('The npm global installation directory could not be verified.')
  await fs.mkdir(prefix, { recursive: true })
  const root = await fs.realpath(prefix)
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(root))
    throw installationError('The npm global installation directory must be on a local disk.')
  const release = await acquireLock(root)
  const work = path.join(root, transactionName)
  const stagedPackage = path.join(work, 'staging', packagePath)
  const target = path.join(root, packagePath)
  let journal: Journal | undefined
  let prepared = false
  try {
    await assertDirectories(root, ['node_modules', path.join('node_modules', '@deepseek-ai')])
    await recover(root, work)
    prepared = true
    void cleanupRetired(root)
    await fs.mkdir(path.join(work, 'staging'), { recursive: true })
    report(options, 'Installing DSH in a separate directory; the current package is unchanged.\n', 'stdout')
    const installed = await dependencies.execute([...args, '--prefix', path.join(work, 'staging')], options)
    const version = await validatePackage(stagedPackage, args)
    await dependencies.verify(path.join(work, 'staging', 'dsh.cmd'), version)
    await fs.mkdir(path.join(work, 'new-shims'))
    await fs.mkdir(path.join(work, 'old-shims'))
    for (const shim of shims) {
      const source = path.join(work, 'staging', shim)
      await assertFile(source)
      const content = await fs.readFile(source, 'utf8')
      if (content.includes(path.join(work, 'staging')))
        throw installationError('The staged DSH launcher contains an unexpected absolute path.')
      await fs.writeFile(path.join(work, 'new-shims', shim), content, { flag: 'wx' })
    }
    journal = {
      previousPackage: await exists(target),
      previousShims: await Promise.all(shims.map((shim) => exists(path.join(root, shim)))),
      committed: false,
    }
    if (journal.previousPackage && (await fs.lstat(target)).isSymbolicLink())
      throw installationError('The existing DSH package is a link. Update it through its owner.')
    for (const [index, shim] of shims.entries())
      if (journal.previousShims[index]) await assertFile(path.join(root, shim))
    // Preparation/verification can be cancelled. Once switching starts, finish or roll back.
    if (options.signal?.aborted === true)
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'The DSH installation was cancelled.',
        retryable: true,
      })
    await options.beforeReplace?.()
    await writeJournal(work, journal)
    report(
      options,
      'Switching the verified DSH package. File-lock retries are limited to 2 seconds.\n',
      'stdout',
    )
    const deadline = Date.now() + 2_000
    if (journal.previousPackage) await move(target, path.join(work, 'previous'), deadline)
    await move(stagedPackage, target, deadline)
    for (const [index, shim] of shims.entries()) {
      if (journal.previousShims[index])
        await move(path.join(root, shim), path.join(work, 'old-shims', shim), deadline)
      await move(path.join(work, 'new-shims', shim), path.join(root, shim), deadline)
    }
    await dependencies.verify(path.join(root, 'dsh.cmd'), version)
    const committed = { ...journal, committed: true }
    await writeJournal(work, committed)
    journal = committed
    await retireWorkspace(root, work, options).catch(() => {
      report(options, 'DSH is verified; cleanup of the retired directory was deferred.\n', 'stdout')
    })
    return installed
  } catch (cause) {
    if (!prepared) throw cause
    // The durable journal also allows the next attempt to recover after a Host crash.
    if (journal !== undefined && !journal.committed && (await exists(path.join(work, 'journal.json')))) {
      try {
        await rollback(root, work, journal)
      } catch (rollbackCause) {
        throw installationError(
          'DSH switching failed and rollback is incomplete. Retry installation to recover the previous package.',
          new AggregateError([cause, rollbackCause]),
        )
      }
    }
    await retireWorkspace(root, work, options).catch(() => undefined)
    if (cause instanceof AppError && cause.context?.reason === 'files-in-use') {
      report(options, 'Checking Windows for processes still holding DSH files…\n', 'stdout')
      const owners = await findWindowsLockOwners([target, ...shims.map((shim) => path.join(root, shim))])
      for (const owner of owners)
        report(
          options,
          `Windows reports DSH files in use by ${owner.name} (PID ${owner.pid}). Close this application and retry.\n`,
          'stdout',
        )
      if (owners.length === 0)
        report(
          options,
          'Windows could not identify the remaining file holder. Check external DSH instances, terminals and security software.\n',
          'stdout',
        )
    }
    throw cause
  } finally {
    await release()
  }
}

async function validatePackage(directory: string, args: readonly string[]): Promise<string> {
  await assertFile(path.join(directory, 'package.json'))
  const metadata: unknown = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('name' in metadata) ||
    metadata.name !== DSH_PACKAGE_NAME ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string' ||
    !isDshPackageVersion(metadata.version)
  )
    throw installationError('The staged DSH package metadata is invalid.')
  const requested = args
    .find((arg) => arg.startsWith(`${DSH_PACKAGE_NAME}@`))
    ?.slice(DSH_PACKAGE_NAME.length + 1)
  if (requested !== undefined && requested !== metadata.version)
    throw installationError('The staged DSH package does not match the requested version.')
  const bin: unknown = 'bin' in metadata ? metadata.bin : undefined
  const entry =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null && 'dsh' in bin
        ? bin.dsh
        : undefined
  if (typeof entry !== 'string' || path.isAbsolute(entry) || entry.includes('\\'))
    throw installationError('The staged DSH executable path is invalid.')
  const relative = path.relative(directory, await fs.realpath(path.resolve(directory, entry)))
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw installationError('The staged DSH executable is outside its package.')
  return metadata.version
}

async function move(source: string, destination: string, deadline = Date.now()): Promise<void> {
  for (;;) {
    try {
      await fs.rename(source, destination)
      return
    } catch (cause) {
      if (!hasCode(cause, 'EPERM', 'EACCES', 'EBUSY')) throw cause
      if (Date.now() >= deadline)
        throw new AppError({
          code: 'BACKEND_BUSY',
          message:
            'DSH files are still in use or not writable. Check DSH Installation output for the locking application, close it and retry. The previous package is preserved.',
          retryable: true,
          context: { operation: 'runtime.install', reason: 'files-in-use' },
          cause,
        })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function writeJournal(work: string, journal: Journal): Promise<void> {
  await fs.writeFile(path.join(work, 'journal.tmp'), JSON.stringify(journal))
  await fs.rename(path.join(work, 'journal.tmp'), path.join(work, 'journal.json'))
}

async function recover(root: string, work: string): Promise<void> {
  if (!(await exists(work))) return
  if ((await fs.lstat(work)).isSymbolicLink()) throw installationError('The DSH staging directory is a link.')
  const file = path.join(work, 'journal.json')
  if (await exists(file)) {
    await assertFile(file)
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('previousPackage' in value) ||
      typeof value.previousPackage !== 'boolean' ||
      !('committed' in value) ||
      typeof value.committed !== 'boolean' ||
      !('previousShims' in value) ||
      !Array.isArray(value.previousShims) ||
      value.previousShims.length !== shims.length ||
      !value.previousShims.every((entry: unknown) => typeof entry === 'boolean')
    )
      throw installationError('The interrupted DSH installation journal is invalid.')
    const journal = value as Journal
    if (!journal.committed) await rollback(root, work, journal)
  }
  await retireWorkspace(root, work)
}

async function rollback(root: string, work: string, journal: Journal): Promise<void> {
  const target = path.join(root, packagePath)
  const previous = path.join(work, 'previous')
  if (await exists(previous)) {
    if (await exists(target)) await move(target, path.join(work, 'failed-package'))
    await move(previous, target)
  } else if (
    !journal.previousPackage &&
    !(await exists(path.join(work, 'staging', packagePath))) &&
    (await exists(target))
  ) {
    await move(target, path.join(work, 'failed-package'))
  }
  for (const [index, shim] of shims.entries()) {
    const targetShim = path.join(root, shim)
    const previousShim = path.join(work, 'old-shims', shim)
    if (await exists(previousShim)) {
      if (await exists(targetShim)) await move(targetShim, path.join(work, `failed-${shim}`))
      await move(previousShim, targetShim)
    } else if (
      !journal.previousShims[index] &&
      !(await exists(path.join(work, 'new-shims', shim))) &&
      (await exists(targetShim))
    ) {
      await move(targetShim, path.join(work, `failed-${shim}`))
    }
  }
}

async function retireWorkspace(root: string, work: string, options?: RuntimeCommandOptions): Promise<void> {
  if (!(await exists(work))) return
  const retired = path.join(root, `.dsh-vscode-retired-${randomUUID()}`)
  await move(work, retired)
  // Do not keep the UI waiting for npm's large-tree trash removal. No live paths are deleted.
  void fs.rm(retired, { recursive: true, force: true, maxRetries: 0 }).catch(() => {
    report(options, 'A retired DSH directory is still in use; cleanup was deferred.\n', 'stdout')
  })
}

async function cleanupRetired(root: string): Promise<void> {
  try {
    const directories = await fs.readdir(root, { withFileTypes: true })
    for (const entry of directories
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^\.dsh-vscode-retired-[a-f0-9-]{36}$/u.test(entry.name),
      )
      .slice(0, 16)) {
      const directory = path.join(root, entry.name)
      if (path.dirname(await fs.realpath(directory)) !== root) continue
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined)
    }
  } catch {
    /* Retired-tree cleanup is advisory and is retried on the next installation. */
  }
}

function report(options: RuntimeCommandOptions | undefined, text: string, stream: 'stdout' | 'stderr'): void {
  try {
    options?.onOutput?.(text, stream)
  } catch {
    /* Closing the output panel must not affect installation or rollback. */
  }
}

async function assertDirectories(root: string, directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    const target = path.join(root, directory)
    await fs.mkdir(target).catch((cause: unknown) => {
      if (!hasCode(cause, 'EEXIST')) throw cause
    })
    const stat = await fs.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw installationError('The npm installation directory contains an unexpected link or file.')
  }
}

async function assertFile(file: string): Promise<void> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536)
    throw installationError('A DSH package or launcher file could not be safely verified.')
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (cause) {
    if (hasCode(cause, 'ENOENT')) return false
    throw cause
  }
}

async function acquireLock(root: string): Promise<() => Promise<void>> {
  const id = createHash('sha256')
    .update(process.platform === 'win32' ? root.toLowerCase() : root)
    .digest('hex')
    .slice(0, 32)
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-vscode-install-${id}`
      : path.join(tmpdir(), `dsh-vscode-install-${id}.sock`)
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', (cause) =>
      reject(
        new AppError({
          code: 'BACKEND_BUSY',
          message: 'Another DSH installation is using this npm directory. Wait for it to finish and retry.',
          retryable: true,
          cause,
        }),
      ),
    )
    server.listen(address, resolve)
  })
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
    )
}

function hasCode(cause: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    codes.includes(cause.code)
  )
}

function installationError(message: string, cause?: unknown): AppError {
  return new AppError({
    code: 'PROCESS_FAILED',
    message,
    retryable: true,
    context: { operation: 'runtime.install', reason: 'transaction-failed' },
    ...(cause === undefined ? {} : { cause }),
  })
}
