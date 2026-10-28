import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openSkillDocument } from './skill-documents.js'

const documentPath = path.resolve('fixture-skills/review/SKILL.md')
describe('native skill documentation boundary', () => {
  it('opens only the resolved provider document', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const signal = new AbortController().signal
    await openSkillDocument(documentPath, open, signal)
    expect(open).toHaveBeenCalledWith(documentPath, signal)
  })
  it.each([
    'relative/SKILL.md',
    'https://example.test/SKILL.md',
    '//server/share/SKILL.md',
    'bad' + String.fromCharCode(0) + '/SKILL.md',
  ])('rejects unsupported locations: %s', async (location) => {
    const open = vi.fn()
    await expect(openSkillDocument(location, open, new AbortController().signal)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(open).not.toHaveBeenCalled()
  })
})
