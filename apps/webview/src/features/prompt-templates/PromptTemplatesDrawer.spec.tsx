// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptTemplate, PromptTemplateInsertion, PromptTemplateSummary } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { PromptTemplatesDrawer } from './PromptTemplatesDrawer.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

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
  focused = false,
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
      {focused ? (
        <ConversationLayoutProvider>
          <PromptTemplatesDrawer {...props} />
        </ConversationLayoutProvider>
      ) : (
        <PromptTemplatesDrawer {...props} />
      )}
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
    expect(screen.getByText('Fill in template variables')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Keep placeholders' }))
    expect(onApply).toHaveBeenCalledWith(template.templateText)
    expect(props.onInsert).toHaveBeenCalledWith(summary.templateId, undefined)
  })

  it('keeps deletion behind a separate confirmation', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Review current change' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(summary.templateId))
  })

  it('keeps a pending save visible on Escape and preserves the draft after failure', async () => {
    let rejectSave!: (reason: Error) => void
    renderDrawer({
      onCreate: vi.fn(
        () =>
          new Promise<PromptTemplateSummary | undefined>((_, reject) => {
            rejectSave = reject
          }),
      ),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const editor = screen.getByRole('dialog', { name: 'Create prompt template' })
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Keep draft' } })
    fireEvent.change(within(editor).getByLabelText('Template text'), { target: { value: 'Keep body' } })
    fireEvent.submit(editor)
    fireEvent.keyDown(within(editor).getByLabelText('Title'), { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Create prompt template' })).toBe(editor)
    rejectSave(new Error('Save failed'))
    await waitFor(() => expect(within(editor).getByRole('alert').textContent).toBe('Save failed'))
    expect(within(editor).getByLabelText('Title')).toHaveProperty('value', 'Keep draft')
    expect(within(editor).getByLabelText('Template text')).toHaveProperty('value', 'Keep body')
  })
})
