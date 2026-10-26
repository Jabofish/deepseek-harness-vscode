import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cacheCompanionArchive,
  inspectCompanionArchive,
  listCompanionArchives,
  alternateCompanionArchive,
} from './companion-archive.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function archive(
  name = '@dsh-vscode/editor-bridge',
  corrupt = false,
  mtime = 0,
  description = 'fixture',
): Buffer {
  const body = Buffer.from(
    JSON.stringify({ name, version: '0.2.0', description, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136)
  header.fill(32, 148, 156)
  header.write('0', 156)
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  if (corrupt) header[0] = 1
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(((512 - (body.length % 512)) % 512) + 1024)]))
}
async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'editor-companion-archive-'))
  roots.push(directory)
  return directory
}
describe('bounded companion archive inspection and recovery cache', () => {
  it('reuses one immutable cache path across repackaging timestamps and concurrent identical requests', async () => {
    const directory = await root()
    const first = path.join(directory, 'first.tgz')
    const second = path.join(directory, 'second.tgz')
    await writeFile(first, archive(undefined, false, 1))
    await writeFile(second, archive(undefined, false, 2))
    const [a, b] = await Promise.all([
      cacheCompanionArchive(first, directory),
      cacheCompanionArchive(second, directory),
    ])
    expect(a).toEqual(b)
    expect(await readdir(path.join(directory, 'editor-companion', 'archives'))).toEqual([
      path.basename(a.file),
    ])
    await writeFile(second, archive(undefined, false, 3, 'different build'))
    expect((await cacheCompanionArchive(second, directory)).file).not.toBe(a.file)
    expect(await listCompanionArchives(directory)).toHaveLength(2)
  })

  it('keeps a bounded immutable alternate path for reinstalling the same artifact and refuses corruption', async () => {
    const directory = await root()
    const file = path.join(directory, 'bundle.tgz')
    await writeFile(file, archive())
    const cached = await cacheCompanionArchive(file, directory)
    const alternate = await alternateCompanionArchive(cached, directory)
    expect(alternate.file).not.toBe(cached.file)
    expect(await readFile(alternate.file)).toEqual(await readFile(cached.file))
    expect(await alternateCompanionArchive(cached, directory)).toEqual(alternate)
    expect(await listCompanionArchives(directory)).toEqual([cached])
    await writeFile(alternate.file, 'tampered')
    await expect(alternateCompanionArchive(cached, directory)).rejects.toThrow()
    expect(await inspectCompanionArchive(cached.file)).toEqual({ version: '0.2.0' })
  })
  it('reads a package manifest without extracting files and retains an immutable verified recovery archive', async () => {
    const directory = await root()
    const file = path.join(directory, 'bundle.tgz')
    await writeFile(file, archive())
    expect(await inspectCompanionArchive(file)).toEqual({ version: '0.2.0' })
    const cached = await cacheCompanionArchive(file, directory)
    expect(cached.version).toBe('0.2.0')
    await writeFile(file, 'changed after caching')
    expect(await inspectCompanionArchive(cached.file)).toEqual({ version: '0.2.0' })
    expect(await listCompanionArchives(directory)).toEqual([cached])
    await writeFile(cached.file, Buffer.concat([await readFile(cached.file), Buffer.from('tampered')]))
    expect(await listCompanionArchives(directory)).toEqual([])
  })
  it('rejects other package identities, malformed checksums and decompression bombs', async () => {
    const directory = await root()
    const file = path.join(directory, 'bundle.tgz')
    for (const bytes of [
      archive('another-package'),
      archive(undefined, true),
      gzipSync(Buffer.alloc(8_388_609)),
    ]) {
      await writeFile(file, bytes)
      await expect(inspectCompanionArchive(file)).rejects.toThrow()
    }
  })
})
