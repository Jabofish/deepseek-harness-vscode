// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  I18nProvider,
  LOCALE_EXPLICIT_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  localeFromLanguageTag,
  useI18n,
} from './i18n.js'

function LocaleProbe(): ReactElement {
  const { locale, setLocale, adoptLocaleFromHost, t } = useI18n()
  return (
    <div>
      <output data-testid="locale">{locale}</output>
      <output data-testid="subagent-translations">
        {[
          t('tasks.kind.subagent'),
          t('subagents.count', { count: 2 }),
          t('composer.referencesSessions'),
          t('presentation.subagent'),
          t('app.error.subagentParentUnavailable'),
        ].join('|')}
      </output>
      <button onClick={() => adoptLocaleFromHost('en', true)}>Host English</button>
      <button onClick={() => adoptLocaleFromHost('zh-Hant-TW', true)}>Host Chinese</button>
      <button onClick={() => adoptLocaleFromHost('fr-FR', true)}>Host unsupported</button>
      <button onClick={() => adoptLocaleFromHost(undefined, false)}>Host unset</button>
      <button onClick={() => setLocale('zh')}>Choose Chinese</button>
    </div>
  )
}

describe('Webview locale bootstrap and Host adoption', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    document.documentElement.lang = 'en'
  })

  it.each([
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh-Hant-TW', 'zh'],
    ['ZH-hans', 'zh'],
    ['en', 'en'],
    ['en-GB', 'en'],
    ['fr-FR', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('normalizes supported language tag %s to %s', (tag, expected) => {
    expect(localeFromLanguageTag(tag)).toBe(expected)
  })

  it.each([
    ['en', 'zh-CN', 'zh'],
    ['zh', 'en', 'zh'],
    ['fr-FR', 'zh-CN', 'en'],
  ])('safely migrates legacy locale %s with editor language %s', async (stored, hostLanguage, expected) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, stored)
    document.documentElement.lang = hostLanguage

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    )

    expect(screen.getByTestId('locale').textContent).toBe(expected)
    await waitFor(() => expect(document.documentElement.lang).toBe(expected === 'zh' ? 'zh-CN' : 'en'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(stored)
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBeNull()
  })

  it('uses the VS Code document language as an unpersisted initial default', async () => {
    document.documentElement.lang = 'zh-Hant'

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    )

    expect(screen.getByTestId('locale').textContent).toBe('zh')
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull()
  })

  it('uses the RC2 子智能体 term in user-facing Chinese subagent labels and errors', () => {
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose Chinese' }))

    expect(screen.getByTestId('subagent-translations').textContent?.split('|')).toEqual([
      '子智能体',
      '2 个子智能体',
      '会话和子智能体',
      '子智能体',
      '父会话不可用，无法进行子智能体追问。',
    ])
  })

  it.each([
    ['en', 'zh-CN', 'en'],
    ['zh', 'en', 'zh'],
  ])('lets explicit local %s override VS Code language %s', async (stored, hostLanguage, expected) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, stored)
    window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
    document.documentElement.lang = hostLanguage

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    )

    expect(screen.getByTestId('locale').textContent).toBe(expected)
    await waitFor(() => expect(document.documentElement.lang).toBe(expected === 'zh' ? 'zh-CN' : 'en'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(stored)
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')
  })

  it('gives explicit DSH language precedence without replacing the local choice', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh')
    window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
    document.documentElement.lang = 'zh-CN'

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Host English' }))
    expect(screen.getByTestId('locale').textContent).toBe('en')
    await waitFor(() => expect(document.documentElement.lang).toBe('en'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh')
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Host Chinese' }))
    expect(screen.getByTestId('locale').textContent).toBe('zh')
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh')
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Host unsupported' }))
    expect(screen.getByTestId('locale').textContent).toBe('en')
    await waitFor(() => expect(document.documentElement.lang).toBe('en'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh')
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')
  })

  it('returns to explicit local choice, then VS Code default, when DSH preference is unset', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
    document.documentElement.lang = 'zh-Hans'

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Host Chinese' }))
    expect(screen.getByTestId('locale').textContent).toBe('zh')
    fireEvent.click(screen.getByRole('button', { name: 'Host unset' }))
    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')

    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    window.localStorage.removeItem(LOCALE_EXPLICIT_STORAGE_KEY)
    fireEvent.click(screen.getByRole('button', { name: 'Host English' }))
    fireEvent.click(screen.getByRole('button', { name: 'Host unset' }))
    expect(screen.getByTestId('locale').textContent).toBe('zh')
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBeNull()
  })
})
