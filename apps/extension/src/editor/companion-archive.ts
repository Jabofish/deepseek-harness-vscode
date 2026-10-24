import { readFile, stat, mkdir, readdir, writeFile, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { EditorCompanionError } from '@dsh-vscode/domain'

export const EDITOR_COMPANION_PACKAGE = '@dsh-vscode/editor-bridge'
export interface CompanionArchive {
  readonly version: string
  readonly file: string
}
export async function cacheCompanionArchive(file: string, storage: string): Promise<CompanionArchive> {
  await inspectCompanionArchive(file)
  const contents = await readFile(file)
  if (contents.length > 20_971_520) throw new EditorCompanionError('limit')
  const directory = path.join(storage, 'editor-companion', 'archives')
  await mkdir(directory, { recursive: true })
  const hash = createHash('sha256').update(contents).digest('hex')
  const destination = path.join(directory, `${hash}.tgz`)
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
  const manifest = await inspectCompanionArchive(destination)
  return { file: destination, version: manifest.version }
}
export async function listCompanionArchives(storage: string): Promise<readonly CompanionArchive[]> {
  const directory = path.join(storage, 'editor-companion', 'archives')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const result: CompanionArchive[] = []
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.tgz$/u.test(name)).slice(0, 32)) {
    const file = path.join(directory, name)
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > 20_971_520) continue
      const bytes = await readFile(file)
      if (createHash('sha256').update(bytes).digest('hex') !== name.slice(0, 64)) continue
      result.push({ file, ...(await inspectCompanionArchive(file)) })
    } catch {
      /* Ignore incomplete/corrupt cached artifacts; never install them. */
    }
  }
  return result
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
/** Read only the bounded package manifest; never extract files or run package code. */
export async function inspectCompanionArchive(file: string): Promise<{ readonly version: string }> {
  const info = await stat(file)
  if (!info.isFile() || info.size > 20_971_520) throw new EditorCompanionError('limit')
  const tar = await promisify(gunzip)(await readFile(file), { maxOutputLength: 8_388_608 })
  let manifest: unknown
  let offset = 0
  let entries = 0
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
  return { version: manifest.version }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
