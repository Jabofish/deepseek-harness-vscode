import { afterEach, describe, expect, it } from 'vitest'
import { setActiveLocale } from '../i18n.js'
import { localizeHostErrorMessage } from './host-error-text.js'

describe('localizeHostErrorMessage', () => {
  afterEach(() => setActiveLocale('en'))

  it('translates the standard sentence and keeps the appended detail', () => {
    setActiveLocale('zh')
    expect(localizeHostErrorMessage('PERMISSION_DENIED', 'The operation is not permitted.')).toBe(
      '不允许执行此操作。',
    )
    expect(
      localizeHostErrorMessage(
        'INVALID_CONFIGURATION',
        'The DSH configuration is invalid. DSH method: settings.mutate. DSH detail: bad value',
      ),
    ).toBe('DSH 配置无效。 DSH method: settings.mutate. DSH detail: bad value')
  })

  it('leaves situation-specific, unknown and English-locale messages unchanged', () => {
    setActiveLocale('zh')
    const specific = 'DSH authentication failed. Run JaboDSH: Authorize External Connection and try again.'
    expect(localizeHostErrorMessage('AUTH_REQUIRED', specific)).toBe(specific)
    expect(localizeHostErrorMessage('NOT_A_CODE', 'Something')).toBe('Something')
    expect(localizeHostErrorMessage(undefined, 'Something')).toBe('Something')
    setActiveLocale('en')
    expect(localizeHostErrorMessage('PERMISSION_DENIED', 'The operation is not permitted.')).toBe(
      'The operation is not permitted.',
    )
  })
})
