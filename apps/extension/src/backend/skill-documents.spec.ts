import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openSkillDocument, publicSkills } from './skill-documents.js'

const documentPath = path.resolve('fixture-skills/review/SKILL.md')
describe('native skill documentation boundary', () => {
  it('publishes only a capability hint and keeps pathless skills callable', () => {
    expect(
      publicSkills([
        { id: 'review', name: 'review', description: '', enabled: false, documentPath },
        { id: 'virtual', name: 'virtual', description: '', enabled: true },
      ]),
    ).toEqual([
      { id: 'review', name: 'review', description: '', enabled: false, hasDocument: true },
      { id: 'virtual', name: 'virtual', description: '', enabled: true },
    ])
  })
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
  it('honors cancellation and surfaces native file errors', async () => {
    const controller = new AbortController()
    controller.abort()
    const open = vi.fn().mockRejectedValue(new Error('File missing'))
    await expect(openSkillDocument(documentPath, open, controller.signal)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    await expect(openSkillDocument(documentPath, open, new AbortController().signal)).rejects.toThrow(
      'File missing',
    )
  })
})
