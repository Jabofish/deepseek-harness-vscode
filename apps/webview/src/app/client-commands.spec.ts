import { describe, expect, it } from 'vitest'
import { isMovetoCommandLine, movetoTargetOf, normalizeClientCommandText } from './client-commands.js'
import { withClientCommandContributions } from './store/command-directory.js'

describe('client command syntax', () => {
  it.each([
    ['/moveto:editor', '/moveto editor'],
    ['/moveto:sidebar', '/moveto sidebar'],
    ['/moveto:EDITOR', '/moveto EDITOR'],
    ['  /moveto:editor  ', '/moveto editor'],
    ['/moveto:', '/moveto'],
  ])('rewrites the short form %s into %s', (line, expected) => {
    expect(normalizeClientCommandText(line)).toBe(expected)
  })

  it.each([['/moveto editor'], ['/moveto'], ['/model'], ['hello'], ['/movetoeditor']])(
    'leaves %s untouched',
    (line) => {
      expect(normalizeClientCommandText(line)).toBe(line)
    },
  )

  it('never rewrites a multi-line draft that merely starts with the command', () => {
    const draft = '/moveto:editor\nand some body'
    expect(normalizeClientCommandText(draft)).toBe(draft)
    expect(isMovetoCommandLine(draft)).toBe(false)
  })

  it.each([
    ['/moveto:editor', 'editor'],
    ['/moveto:sidebar', 'sidebar'],
    ['/moveto editor', 'editor'],
    ['/moveto SIDEBAR', 'sidebar'],
    ['/moveto', undefined],
    ['/moveto:bogus', undefined],
    ['/moveto bogus', undefined],
    ['/moveto:bogus trailing', undefined],
  ])('resolves the target of %s to %s', (line, expected) => {
    expect(movetoTargetOf(line)).toBe(expected)
  })

  it.each([
    ['/moveto', true],
    ['/moveto:editor', true],
    ['/moveto editor', true],
    ['/moveto:bogus', true],
    ['/moveto bogus', true],
    ['/movetoeditor', false],
    ['/model', false],
    ['an ordinary prompt', false],
    ['', false],
  ])('claims %s as a client-owned line: %s', (line, expected) => {
    expect(isMovetoCommandLine(line)).toBe(expected)
  })
})

describe('client command directory rows', () => {
  it('advertises the move command next to the model row', () => {
    const commands = withClientCommandContributions([])
    expect(commands.map((command) => command.name)).toEqual(['model', 'moveto'])
    expect(commands.find((command) => command.name === 'moveto')?.input).toEqual({
      hint: '[editor|sidebar]',
    })
  })

  it('does not duplicate a row the host directory already declares', () => {
    const commands = withClientCommandContributions([
      { name: 'model', description: 'Host model command', source: 'builtin' },
      { name: 'moveto', description: 'Host move command', source: 'builtin' },
    ])
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => command.source === 'builtin')).toBe(true)
  })

  it('adds only the missing row', () => {
    const commands = withClientCommandContributions([
      { name: 'model', description: 'Host model command', source: 'builtin' },
    ])
    expect(commands.map((command) => command.name)).toEqual(['model', 'moveto'])
  })
})
