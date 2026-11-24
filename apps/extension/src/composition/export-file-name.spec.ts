import { describe, expect, it } from 'vitest'
import { exportFileBaseName } from './export-file-name.js'

describe('exportFileBaseName', () => {
  it('replaces characters file systems refuse and falls back for an empty title', () => {
    expect(exportFileBaseName('Fix: a/b\\c?')).toBe('Fix- a-b-c')
    expect(exportFileBaseName('  \n ')).toBe('dsh-session')
  })

  it('never splits an emoji when it bounds the length', () => {
    const name = exportFileBaseName(`${'a'.repeat(79)}😀tail`)
    expect(Array.from(name)).toHaveLength(80)
    expect(name.endsWith('😀')).toBe(true)
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  })

  it('keeps reserved Windows device names and trailing dots out of the file name', () => {
    expect(exportFileBaseName('con')).toBe('con-session')
    expect(exportFileBaseName('COM1')).toBe('COM1-session')
    expect(exportFileBaseName('Notes...')).toBe('Notes')
    expect(exportFileBaseName('console')).toBe('console')
  })
})
