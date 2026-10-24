import { readFile, stat, mkdir, readdir, writeFile, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { gunzip, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { EditorCompanionError } from '@dsh-vscode/domain'

export const EDITOR_COMPANION_PACKAGE = '@dsh-vscode/editor-bridge'
export interface CompanionArchive {
  readonly version: string
  readonly file: string
}
export async function cacheCompanionArchive(file: string, storage: string): Promise<CompanionArchive> {
  const inspected = await canonicalCompanionArchive(file)
  const contents = inspected.contents
  const directory = path.join(storage, 'editor-companion', 'archives')
  await mkdir(directory, { recursive: true })
  const hash = createHash('sha256').update(contents).digest('hex')
  const destination = path.join(directory, `${hash}.tgz`)
  // Reuse legacy cache paths too: a profile may still refer to one of them.
  // Comparing canonical archives ignores packaging timestamps and compression
  // metadata, but preserves every packaged file, mode, link and file order.
  for (const cached of await listCompanionArchives(storage)) {
    try {
      const candidate = await canonicalCompanionArchive(cached.file, path.basename(cached.file, '.tgz'))
      if (createHash('sha256').update(candidate.contents).digest('hex') === hash) return cached
    } catch {
      /* Another cache operation may have removed a previously listed file. */
    }
  }
  const existing = await readdir(directory)
  if (existing.length >= 32 && !existing.includes(`${hash}.tgz`)) throw new EditorCompanionError('limit')
  try {
    await writeFile(destination, contents, { flag: 'wx' })
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'))
      throw error
  }
  const cached = await readFile(destination)
  if (createHash('sha256').update(cached).digest('hex') !== hash)
    throw new EditorCompanionError('invalid-response')
  return { file: destination, version: inspected.version }
}
export async function listCompanionArchives(storage: string): Promise<readonly CompanionArchive[]> {
  const directory = path.join(storage, 'editor-companion', 'archives')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const result: { archive: CompanionArchive; modified: number; identity: string }[] = []
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.tgz$/u.test(name)).slice(0, 32)) {
    const file = path.join(directory, name)
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > 20_971_520) continue
      const inspected = await canonicalCompanionArchive(file, name.slice(0, 64))
      result.push({
        archive: { file, version: inspected.version },
        modified: info.mtimeMs,
        identity: createHash('sha256').update(inspected.contents).digest('hex'),
      })
    } catch {
      /* Ignore incomplete/corrupt cached artifacts; never install them. */
    }
  }
  result.sort((a, b) => b.modified - a.modified || a.archive.file.localeCompare(b.archive.file))
  const seen = new Set<string>()
  return result.flatMap((item) => {
    if (seen.has(item.identity)) return []
    seen.add(item.identity)
    return [item.archive]
  })
}
/** HMR rejects the currently saved tarball path. Keep one immutable alternate per hash for repair. */
export async function alternateCompanionArchive(
  archive: CompanionArchive,
  storage: string,
): Promise<CompanionArchive> {
  const cached = await cacheCompanionArchive(archive.file, storage)
  const directory = path.join(storage, 'editor-companion', 'reinstall')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, path.basename(cached.file))
  try {
    await copyFile(cached.file, file, constants.COPYFILE_EXCL)
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'))
      throw error
  }
  const bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== path.basename(cached.file, '.tgz'))
    throw new EditorCompanionError('invalid-response')
  return { file, ...(await inspectCompanionArchive(file)) }
}
/** Validate a bounded companion tarball; never extract files or run package code. */
export async function inspectCompanionArchive(file: string): Promise<{ readonly version: string }> {
  return { version: (await canonicalCompanionArchive(file)).version }
}

async function canonicalCompanionArchive(
  file: string,
  expectedHash?: string,
): Promise<{ version: string; contents: Buffer }> {
  const info = await stat(file)
  if (!info.isFile() || info.size > 20_971_520) throw new EditorCompanionError('limit')
  const bytes = await readFile(file)
  if (bytes.length > 20_971_520) throw new EditorCompanionError('limit')
  if (expectedHash !== undefined && createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new EditorCompanionError('invalid-response')
  const tar = await promisify(gunzip)(bytes, { maxOutputLength: 8_388_608 })
  let manifest: unknown
  let offset = 0
  let entries = 0
  const canonical: Buffer[] = []
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    if (++entries > 200) throw new EditorCompanionError('limit')
    const field = (start: number, size: number): string =>
      header
        .subarray(start, start + size)
        .toString('utf8')
        .replace(/\0.*$/su, '')
        .trim()
    const octal = (start: number, length: number): number => {
      const value = field(start, length)
      if (!/^[0-7]+$/u.test(value)) throw new EditorCompanionError('invalid-response')
      return Number.parseInt(value, 8)
    }
    const checksum = [...header].reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (checksum !== octal(148, 8)) throw new EditorCompanionError('invalid-response')
    const size = octal(124, 12)
    if (!Number.isSafeInteger(size) || size > tar.length - offset - 512)
      throw new EditorCompanionError('invalid-response')
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/')
    if (name === 'package/package.json') {
      if (manifest !== undefined || size > 65_536 || (field(156, 1) !== '' && field(156, 1) !== '0'))
        throw new EditorCompanionError('invalid-response')
      manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8')) as unknown
    }
    const normalized = Buffer.from(header)
    // Ownership and modification times are packaging metadata, not build
    // identity. Recompute the TAR checksum after normalizing those fields.
    normalized.write('0000000\0', 108, 8)
    normalized.write('0000000\0', 116, 8)
    normalized.write('00000000000\0', 136, 12)
    normalized.fill(0, 265, 329)
    normalized.fill(32, 148, 156)
    const normalizedChecksum = [...normalized].reduce((sum, byte) => sum + byte, 0)
    normalized.write(normalizedChecksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    canonical.push(
      normalized,
      tar.subarray(offset + 512, offset + 512 + size),
      Buffer.alloc((512 - (size % 512)) % 512),
    )
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (
    !record(manifest) ||
    manifest.name !== EDITOR_COMPANION_PACKAGE ||
    typeof manifest.version !== 'string' ||
    manifest.version.length > 128 ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version) ||
    !record(manifest.dsh) ||
    !record(manifest.dsh.bundle) ||
    typeof manifest.dsh.bundle.patch !== 'string'
  )
    throw new EditorCompanionError('invalid-response')
  canonical.push(Buffer.alloc(1024))
  return { version: manifest.version, contents: await promisify(gzip)(Buffer.concat(canonical)) }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
