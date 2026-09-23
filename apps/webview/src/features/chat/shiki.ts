import type { HighlighterGeneric, LanguageInput, ThemeInput } from 'shiki/core'

export const SHIKI_THEMES = {
  light: 'github-light-default',
  dark: 'github-dark-default',
} as const

const themeLoaders = {
  [SHIKI_THEMES.light]: () => import('@shikijs/themes/github-light-default'),
  [SHIKI_THEMES.dark]: () => import('@shikijs/themes/github-dark-default'),
} satisfies Record<string, ThemeInput>

export type WebviewTheme = keyof typeof themeLoaders

/**
 * The grammars this Webview may ship. Every entry stays a lazy import, so a
 * conversation only fetches the grammars it renders. Shiki's full bundle would
 * emit 300+ grammar chunks (10 MB) plus a sourcemap each into the extension
 * media folder for languages that never appear in a session.
 */
const languageLoaders = {
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  shell: () => import('@shikijs/langs/shell'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} satisfies Record<string, LanguageInput>

export type WebviewLanguage = keyof typeof languageLoaders
export type WebviewHighlighter = HighlighterGeneric<WebviewLanguage, WebviewTheme>

// Model-authored fences use dozens of spellings for the same grammar. Every
// target is a bundled id; a spelling that is neither listed here nor a bundled
// id itself renders as plaintext instead of requesting a grammar the Webview
// cannot load.
const LANGUAGE_ALIASES: Readonly<Record<string, WebviewLanguage>> = {
  bash: 'shell',
  cjs: 'javascript',
  cs: 'csharp',
  cxx: 'cpp',
  htm: 'html',
  md: 'markdown',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  sh: 'shell',
  svg: 'xml',
  ts: 'typescript',
  yml: 'yaml',
}

let highlighterPromise: Promise<WebviewHighlighter> | undefined

/** Lazily create one Webview highlighter and share its grammar cache. */
export function getWebviewHighlighter(): Promise<WebviewHighlighter> {
  highlighterPromise ??= createWebviewHighlighter().catch((reason: unknown) => {
    // A chunk that failed to load is a transient Webview condition, not a
    // permanent one: caching the rejection would leave every later code block
    // unhighlighted for the rest of the session.
    highlighterPromise = undefined
    throw reason
  })
  return highlighterPromise
}

/**
 * Shiki's core and its regex engine only matter once a conversation renders
 * code, so both stay out of the always-loaded Webview chunk.
 *
 * The Webview CSP has no `wasm-unsafe-eval`, so the Webview refuses
 * `WebAssembly.instantiate` and Shiki's Oniguruma engine can never start. The
 * JavaScript engine needs no WebAssembly and highlights the bounded set above.
 */
async function createWebviewHighlighter(): Promise<WebviewHighlighter> {
  const [{ createBundledHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ])
  return createBundledHighlighter<WebviewLanguage, WebviewTheme>({
    langs: languageLoaders,
    themes: themeLoaders,
    engine: () => createJavaScriptRegexEngine(),
  })({ themes: Object.values(SHIKI_THEMES), langs: [] })
}

/** Resolve the language ids Markdown and read cards are allowed to highlight. */
export function resolveBundledLanguage(value: string | undefined): WebviewLanguage | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return undefined
  if (Object.hasOwn(languageLoaders, normalized)) return normalized as WebviewLanguage
  return LANGUAGE_ALIASES[normalized]
}
