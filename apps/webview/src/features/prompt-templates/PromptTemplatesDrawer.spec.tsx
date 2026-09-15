// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptTemplate, PromptTemplateInsertion, PromptTemplateSummary } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { PromptTemplatesDrawer } from './PromptTemplatesDrawer.js'

const summary: PromptTemplateSummary = {
  templateId: 'dsh-template-1',
  title: 'Review current change',
  description: 'Review the active editor selection.',
  scope: 'global',
  updatedAt: 1_000,
  variables: ['selection'],
  enabled: true,
}

const template: PromptTemplate = {
  ...summary,
  templateText: '# Review\n\n{{selection}}',
}

function renderDrawer(
  overrides: Partial<React.ComponentProps<typeof PromptTemplatesDrawer>> = {},
): React.ComponentProps<typeof PromptTemplatesDrawer> {
  const props: React.ComponentProps<typeof PromptTemplatesDrawer> = {
    templates: [summary],
    loading: false,
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onRead: vi.fn().mockResolvedValue(template),
    onInsert: vi.fn().mockResolvedValue({
      templateId: summary.templateId,
      text: template.templateText,
      unresolvedVariables: ['selection'],
    } satisfies PromptTemplateInsertion),
    onCreate: vi.fn().mockResolvedValue(summary),
    onUpdate: vi.fn().mockResolvedValue(summary),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onApply: vi.fn(),
    ...overrides,
  }
  render(
    <I18nProvider>
      <PromptTemplatesDrawer {...props} />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: `${props.templates.length} templates` }))
  return props
}

describe('PromptTemplatesDrawer', () => {
  afterEach(() => cleanup())

  it('previews safely and requires an explicit decision for missing variables', async () => {
    const onApply = vi.fn()
    const props = renderDrawer({ onApply })
    fireEvent.click(screen.getByRole('button', { name: /^Review current change/u }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Template preview' })).toBeDefined())
    expect(screen.getByRole('heading', { name: 'Review' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined())
    expect(screen.getByText('Template context is missing')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Keep placeholders' }))
    expect(onApply).toHaveBeenCalledWith(template.templateText)
    expect(props.onInsert).toHaveBeenCalledWith(summary.templateId, undefined)
  })

  it('creates a user template through the form and never sends it automatically', async () => {
    const onCreate = vi.fn().mockResolvedValue(summary)
    renderDrawer({ templates: [], onCreate })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: '  New template  ' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Description' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Template text' }), {
      target: { value: 'Explain {{selection}}' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: '{{selection}}' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      title: '  New template  ',
      templateText: 'Explain {{selection}}',
      variables: ['selection'],
    })
  })

  it('keeps deletion behind a separate confirmation', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Review current change' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(summary.templateId))
  })

  it('keeps the editor open when Escape only dismisses the nested scope menu', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Draft title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Scope: Global' }))
    expect(screen.getByRole('listbox', { name: 'Scope' })).toBeDefined()

    fireEvent.keyDown(screen.getByRole('option', { name: 'Global' }), { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Scope' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('value', 'Draft title')
  })

  it('still closes the editor on Escape when no inner layer consumed it', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Prompt template library' })).toBeDefined()
  })

  it('still closes the popover on Escape when no dialog is open', () => {
    renderDrawer()
    fireEvent.keyDown(screen.getByRole('button', { name: '1 templates' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Prompt template library' })).toBeNull()
  })

  it('takes focus into the delete confirmation and gives it back to the row', () => {
    renderDrawer()

    const trigger = screen.getByRole('button', { name: 'Delete Review current change' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('takes focus into the missing-variables dialog and gives it back to the insert action', async () => {
    renderDrawer()

    fireEvent.click(screen.getByRole('button', { name: /^Review current change/u }))
    const insert = await screen.findByRole('button', { name: 'Insert' })
    insert.focus()
    fireEvent.click(insert)

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep placeholders' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(insert)
  })
})
