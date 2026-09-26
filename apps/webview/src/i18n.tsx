import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import en from './locales/en.json'
import zh from './locales/zh.json'

/** Shared extension/DSH UI languages, mirroring the upstream locale axis (en is the base). */
export type Locale = 'en' | 'zh'

export const LOCALE_STORAGE_KEY = 'dsh-webview-locale'
export const LOCALE_EXPLICIT_STORAGE_KEY = 'dsh-webview-locale-explicit'

/** Map the supported language families to the dictionaries shipped by this Webview. */
export function localeFromLanguageTag(value: unknown): Locale | undefined {
  if (typeof value !== 'string') return undefined
  const tag = value.trim()
  if (/^zh(?:-[A-Za-z0-9]{1,8})*$/iu.test(tag)) return 'zh'
  if (/^en(?:-[A-Za-z0-9]{1,8})*$/iu.test(tag)) return 'en'
  return undefined
}

/**
 * Per-locale dictionaries; keys are stable identifiers. The messages live in
 * `locales/<locale>.json` next to this file so copy can be edited without
 * touching this module; `node scripts/i18n.mjs` is the supported editor.
 */
const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { en, zh }

/** Translator signature shared by components that thread `t` into helpers. */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export interface I18nContextValue {
  readonly locale: Locale
  readonly setLocale: (locale: Locale) => void
  /** Adopt Host state without persisting an inferred fallback or writing back to DSH. */
  readonly adoptLocaleFromHost: (value: unknown, hasExplicitPreference: boolean) => void
  /** Translate one key with `{placeholder}` interpolation; en falls through to the key's base text. */
  readonly t: Translate
}

/** Active locale for module-level surfaces (store, protocol client) that have
 * no React context. Kept in sync by the provider below; English is the base. */
let activeLocale: Locale = 'en'
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale
}

/** Translate outside React, always against the current active locale. */
export function translate(key: string, params?: Readonly<Record<string, string | number>>): string {
  const template = DICTIONARIES[activeLocale][key] ?? DICTIONARIES.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

function storedLocale(): Locale | undefined {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === null) return undefined
    const normalized = localeFromLanguageTag(stored)
    if (window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY) === 'true') return normalized ?? 'en'
    // Before the explicit marker existed, opening Settings could pass the
    // Host's effective `en` through setLocale. Preserve legacy Chinese picks,
    // but let ambiguous legacy English follow the editor's initial default.
    if (normalized === 'zh') return 'zh'
    if (stored === 'en') return undefined
    return 'en'
  } catch {
    return undefined
  }
}

function localeFromDocument(): Locale {
  if (typeof document === 'undefined') return 'en'
  return localeFromLanguageTag(document.documentElement.lang) ?? 'en'
}

/**
 * UI locale provider. Explicit user choices persist in localStorage; App adopts
 * explicit DSH state separately and uses VS Code's document language only as
 * the initial fallback.
 */
export function I18nProvider(props: { readonly children: ReactNode }): React.JSX.Element {
  // Capture VS Code's language once as a default. It is never persisted and
  // loses to either an explicit Webview choice or an explicit DSH setting.
  const [editorLocale] = useState<Locale>(localeFromDocument)
  const [locale, setLocaleState] = useState<Locale>(() => storedLocale() ?? editorLocale)
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    setActiveLocale(locale)
  }, [locale])
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    setActiveLocale(next)
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
      window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
    } catch {
      // Storage can be unavailable in sandboxed frames; the choice stays for this view.
    }
  }, [])
  const adoptLocaleFromHost = useCallback(
    (value: unknown, hasExplicitPreference: boolean): void => {
      const next = hasExplicitPreference
        ? (localeFromLanguageTag(value) ?? 'en')
        : (storedLocale() ?? editorLocale)
      setLocaleState(next)
      setActiveLocale(next)
    },
    [editorLocale],
  )
  const t = useCallback<I18nContextValue['t']>(
    (key, params) => {
      const template = DICTIONARIES[locale][key] ?? DICTIONARIES.en[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match,
      )
    },
    [locale],
  )
  const value = useMemo(
    () => ({ locale, setLocale, adoptLocaleFromHost, t }),
    [locale, setLocale, adoptLocaleFromHost, t],
  )
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

/** Base-language value used when a surface renders outside the provider. */
const FALLBACK: I18nContextValue = {
  locale: 'en',
  setLocale: () => {},
  adoptLocaleFromHost: () => {},
  t: (key, params) => {
    const template = DICTIONARIES.en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    )
  },
}

/** Access the active locale and translator; English outside any provider. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK
}
