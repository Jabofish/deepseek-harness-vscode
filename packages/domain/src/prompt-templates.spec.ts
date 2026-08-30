import { describe, expect, it } from 'vitest'

import {
  expandPromptTemplate,
  normalizePromptTemplateDraft,
  resolvePromptMode,
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
  it('normalizes metadata while retaining literal user-authored text', () => {
    expect(normalizePromptTemplateDraft(draft())).toEqual({
      title: 'Review',
      description: 'Review the change.',
      templateText: 'Review {{selection}} in {{currentFile}}.',
      scope: 'global',
      variables: ['selection', 'currentFile'],
    })
  })

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

  it('maps semantic modes only through advertised capabilities', () => {
    expect(resolvePromptMode('plan', { planCommandAvailable: true })).toMatchObject({
      mode: 'plan',
      supported: true,
      planEnabled: true,
    })
    expect(resolvePromptMode('plan', { planCommandAvailable: false })).toMatchObject({
      mode: 'plan',
      supported: false,
      planEnabled: false,
    })
    expect(resolvePromptMode('act', { planCommandAvailable: false })).toMatchObject({
      mode: 'act',
      supported: true,
      planEnabled: false,
    })
  })
})
