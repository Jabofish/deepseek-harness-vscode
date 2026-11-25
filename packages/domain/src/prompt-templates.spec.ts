import { describe, expect, it } from 'vitest'

import {
  MAX_PROMPT_TEMPLATE_VARIABLE_BYTES,
  expandPromptTemplate,
  fitPromptTemplateVariableValue,
  normalizePromptTemplateDraft,
  type PromptTemplateDraft,
} from './prompt-templates.js'

function draft(overrides: Partial<PromptTemplateDraft> = {}): PromptTemplateDraft {
  return {
    title: '  Review  ',
    description: '  Review the change.  ',
    templateText: 'Review {{selection}} in {{currentFile}}.',
    scope: 'global' as const,
    variables: ['selection', 'currentFile'],
    ...overrides,
  }
}

describe('prompt template domain', () => {
  it('requires every recognized placeholder to be explicitly declared', () => {
    expect(() => normalizePromptTemplateDraft(draft({ variables: ['selection'] }))).toThrowError(
      /currentFile/u,
    )
    expect(() =>
      normalizePromptTemplateDraft(draft({ templateText: 'Run {{shell}}', variables: ['shell'] })),
    ).toThrowError(/shell/u)
  })

  it('rejects empty or oversized template content', () => {
    expect(() => normalizePromptTemplateDraft(draft({ title: ' ' }))).toThrow()
    expect(() => normalizePromptTemplateDraft(draft({ templateText: 'x'.repeat(100_001) }))).toThrow()
  })

  it('expands only declared variables and leaves unknown markup inert', () => {
    const template = {
      templateId: 'template-1',
      templateText: '{{selection}} {{unknown}} {{currentFile}}',
      variables: ['selection', 'currentFile'] as const,
    }
    const result = expandPromptTemplate(template, { selection: 'safe', currentFile: '' })
    expect(result.text).toBe('safe {{unknown}} ')
    expect(result.unresolvedVariables).toEqual([])
  })

  it('reports missing declared values without invoking code or expressions', () => {
    const result = expandPromptTemplate(
      {
        templateId: 'template-2',
        templateText: '<script>ignored</script> {{selection}}',
        variables: ['selection'],
      },
      undefined,
    )
    expect(result.text).toContain('<script>ignored</script>')
    expect(result.unresolvedVariables).toEqual(['selection'])
  })

  it('fits an oversized context value so the template still expands', () => {
    const selection = `${'a'.repeat(MAX_PROMPT_TEMPLATE_VARIABLE_BYTES - 1)}中tail`
    const fitted = fitPromptTemplateVariableValue(selection)
    expect(new TextEncoder().encode(fitted).length).toBeLessThanOrEqual(MAX_PROMPT_TEMPLATE_VARIABLE_BYTES)
    expect(fitted).toBe('a'.repeat(MAX_PROMPT_TEMPLATE_VARIABLE_BYTES - 1))
    expect(fitPromptTemplateVariableValue('short')).toBe('short')
    expect(() =>
      expandPromptTemplate(
        { templateId: 't', templateText: 'Fix {{selection}}', variables: ['selection'] },
        { selection: fitted, currentDiagnostics: fitPromptTemplateVariableValue('x'.repeat(50_000)) },
      ),
    ).not.toThrow()
  })
})
