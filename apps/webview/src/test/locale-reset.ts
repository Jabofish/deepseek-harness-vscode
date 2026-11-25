import { beforeEach } from 'vitest'
import { LOCALE_EXPLICIT_STORAGE_KEY, LOCALE_STORAGE_KEY, setActiveLocale } from '../i18n.js'

/**
 * The webview project keeps one jsdom environment and its modules for every
 * file a worker runs, so a test that switches to Chinese would leave the next
 * file reading Chinese from `translate`, the stored choice or the document
 * language. Start every test in English, the language a Webview starts in.
 */
beforeEach(() => {
  setActiveLocale('en')
  // Only a jsdom file has a document; a node file may install its own `window`.
  if (typeof document === 'undefined') return
  try {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    window.localStorage.removeItem(LOCALE_EXPLICIT_STORAGE_KEY)
  } catch {
    // A test may replace storage with one that throws; it then owns the locale.
  }
  document.documentElement.removeAttribute('lang')
})
