// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import {
  CommandPalette,
  commandMenuOptionId,
  commandMenuRows,
  firstCommandPaletteSelection,
  parsePaletteQuery,
  type CommandArgumentOption,
} from './CommandPalette.js'

const commands: readonly DynamicCommand[] = [
  { name: 'goal', description: 'Set the agent goal', input: { hint: '<goal>' } },
  { name: 'plan', description: 'Toggle planning mode', input: { hint: '[off]' } },
  { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
  { name: 'clear', description: 'Clear the timeline' },
]

const permissionOptions: readonly CommandArgumentOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'yolo', label: 'Yolo' },
]

describe('CommandPalette', () => {
  afterEach(() => cleanup())

  it('renders fuzzy-ranked command candidates for a name query', () => {
    render(<CommandPalette commands={commands} query="/p" onExecute={vi.fn()} />)
    const menu = screen.getByRole('listbox', { name: 'Commands' })
    const options = within(menu).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('/plan'),
      expect.stringContaining('/permission'),
    ])
  })

  it('reports status when no command matches the query', () => {
    render(<CommandPalette commands={commands} query="/zzz" onExecute={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('/zzz')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders nothing while dismissed for the current query', () => {
    render(<CommandPalette commands={commands} query="/p" dismissedFor="/p" onExecute={vi.fn()} />)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders argument options once the query carries an argument', () => {
    render(
      <CommandPalette
        commands={commands}
        query="/permission "
        argumentOptions={permissionOptions}
        onExecute={vi.fn()}
      />,
    )
    const menu = screen.getByRole('listbox', { name: 'Arguments for /permission' })
    expect(within(menu).getAllByRole('option').length).toBe(2)
  })

  it('filters argument options by the argument query', () => {
    render(
      <CommandPalette
        commands={commands}
        query="/permission y"
        argumentOptions={permissionOptions}
        onExecute={vi.fn()}
      />,
    )
    const menu = screen.getByRole('listbox', { name: 'Arguments for /permission' })
    const options = within(menu).getAllByRole('option')
    expect(options.length).toBe(1)
    expect(options[0]?.getAttribute('aria-label')).toBe('Use /permission yolo')
  })

  it('shows the input hint when a command has no completion options', () => {
    render(<CommandPalette commands={commands} query="/goal " argumentOptions={[]} onExecute={vi.fn()} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('/goal')
    expect(status.textContent).toContain('<goal>')
  })

  it('reports status when no argument option matches', () => {
    render(
      <CommandPalette
        commands={commands}
        query="/permission zz"
        argumentOptions={permissionOptions}
        onExecute={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('No matching arguments')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('marks the highlighted row as the active descendant', () => {
    render(<CommandPalette commands={commands} query="/p" highlight={1} onExecute={vi.fn()} />)
    const highlighted = screen.getByRole('option', { selected: true })
    expect(highlighted.id).toBe(commandMenuOptionId(1))
    expect(highlighted.className).toContain('dsh-command-palette__item--highlighted')
  })

  it('executes a command row on mousedown', () => {
    const onExecute = vi.fn()
    render(<CommandPalette commands={commands} query="/p" onExecute={onExecute} />)
    const menu = screen.getByRole('listbox', { name: 'Commands' })
    const planRow = within(menu).getByText('/plan').closest('button') as HTMLButtonElement
    fireEvent.mouseDown(planRow)
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute).toHaveBeenCalledWith('plan')
  })

  it('executes an argument row on mousedown', () => {
    const onExecute = vi.fn()
    render(
      <CommandPalette
        commands={commands}
        query="/permission "
        argumentOptions={permissionOptions}
        onExecute={onExecute}
      />,
    )
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Use /permission yolo' }))
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute).toHaveBeenCalledWith('permission', 'yolo')
  })
})

describe('commandMenuRows', () => {
  it('yields ranked command rows for a name query', () => {
    const rows = commandMenuRows('/p', commands)
    expect(rows.map((row) => (row.kind === 'command' ? row.command.name : row.kind))).toEqual([
      'plan',
      'permission',
    ])
  })

  it('yields argument rows once the query carries an argument', () => {
    const rows = commandMenuRows('/permission y', commands, permissionOptions)
    expect(rows.map((row) => (row.kind === 'argument' ? row.option.value : row.kind))).toEqual(['yolo'])
  })

  it('yields no rows while dismissed queries render nothing', () => {
    // Dismissal is a render concern; the row model still mirrors the query so
    // the composer's keyboard arbitration and the menu can never disagree.
    expect(commandMenuRows('/zzz', commands)).toEqual([])
  })
})

describe('firstCommandPaletteSelection', () => {
  it('returns the top-ranked command', () => {
    const selection = firstCommandPaletteSelection('/p', commands)
    expect(selection?.command.name).toBe('plan')
    expect(selection?.argument).toBeUndefined()
  })

  it('returns the top-ranked argument for an argument query', () => {
    const selection = firstCommandPaletteSelection('/permission y', commands, permissionOptions)
    expect(selection?.command.name).toBe('permission')
    expect(selection?.argument).toBe('yolo')
  })

  it('falls back to the bare command when no argument option matches', () => {
    const selection = firstCommandPaletteSelection('/permission zz', commands, permissionOptions)
    expect(selection?.command.name).toBe('permission')
    expect(selection?.argument).toBeUndefined()
  })

  it('answers undefined when nothing matches', () => {
    expect(firstCommandPaletteSelection('/zzz', commands)).toBeUndefined()
  })
})

describe('parsePaletteQuery', () => {
  it('parses a bare trigger into an empty name', () => {
    expect(parsePaletteQuery('/')).toEqual({ name: '' })
  })

  it('parses a name query lowercased', () => {
    expect(parsePaletteQuery('/Go')).toEqual({ name: 'go' })
  })

  it('separates the argument after inline whitespace', () => {
    expect(parsePaletteQuery('/goal fix bugs')).toEqual({ name: 'goal', argument: 'fix bugs' })
  })
})
