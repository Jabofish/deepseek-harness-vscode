// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { CommandPalette } from './CommandPalette.js'
import { PopupSelectRegistry } from './popupSelectRegistry.js'

const commands: readonly DynamicCommand[] = [
  { name: 'goal', description: 'Set the agent goal', input: { hint: '<goal>' } },
  { name: 'plan', description: 'Toggle planning mode', input: { hint: '[off]' } },
  { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
  { name: 'clear', description: 'Clear the timeline' },
]

describe('CommandPalette', () => {
  afterEach(() => cleanup())

  it('routes a decorated bare command to popupSelect instead of executing the wire command', () => {
    const onExecute = vi.fn()
    const onPopupSelect = vi.fn()
    const popupSelects = new PopupSelectRegistry()
    popupSelects.register({ command: 'plan', onOpen: vi.fn() })
    render(
      <CommandPalette
        commands={commands}
        query="/p"
        popupSelects={popupSelects}
        onPopupSelect={onPopupSelect}
        onExecute={onExecute}
      />,
    )
    fireEvent.mouseDown(screen.getByRole('option', { name: /\/plan/u }))
    expect(onPopupSelect).toHaveBeenCalledWith('plan')
    expect(onExecute).not.toHaveBeenCalled()
  })
})

describe('skill documentation menu action', () => {
  afterEach(() => cleanup())
  it('opens documentation without executing the skill and hides the action for pathless rows', () => {
    const onExecute = vi.fn()
    const onOpenSkillDocument = vi.fn()
    const rows: readonly DynamicCommand[] = [
      { name: 'review', description: 'Review', source: 'skill', hasDocument: true },
      { name: 'virtual', description: 'Virtual', source: 'skill' },
    ]
    const view = render(
      <CommandPalette
        commands={rows}
        query="/"
        onExecute={onExecute}
        onOpenSkillDocument={onOpenSkillDocument}
      />,
    )
    const button = screen.getByRole('button', { name: 'Open /review documentation' })
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    expect(onOpenSkillDocument).toHaveBeenCalledWith('review')
    expect(onExecute).not.toHaveBeenCalled()
    view.rerender(
      <CommandPalette
        commands={rows}
        query="/virtual"
        onExecute={onExecute}
        onOpenSkillDocument={onOpenSkillDocument}
      />,
    )
    expect(screen.queryByRole('button', { name: /documentation/u })).toBeNull()
    fireEvent.mouseDown(screen.getByRole('option'))
    expect(onExecute).toHaveBeenCalledWith('virtual')
  })
})
