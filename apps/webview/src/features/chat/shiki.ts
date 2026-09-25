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
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  haskell: () => import('@shikijs/langs/haskell'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  makefile: () => import('@shikijs/langs/makefile'),
  markdown: () => import('@shikijs/langs/markdown'),
  perl: () => import('@shikijs/langs/perl'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shell: () => import('@shikijs/langs/shell'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  terraform: () => import('@shikijs/langs/terraform'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
  zig: () => import('@shikijs/langs/zig'),
} satisfies Record<string, LanguageInput>

export type WebviewLanguage = keyof typeof languageLoaders
export type WebviewHighlighter = HighlighterGeneric<WebviewLanguage, WebviewTheme>

// Model-authored fences use dozens of spellings for the same grammar. Every
// target is a bundled id; a spelling that is neither listed here nor a bundled
// id itself renders as plaintext instead of requesting a grammar the Webview
// cannot load.
const LANGUAGE_ALIASES: Readonly<Record<string, WebviewLanguage>> = {
  bash: 'shell',
  'c++': 'cpp',
  cc: 'cpp',
  cjs: 'javascript',
  cs: 'csharp',
  cxx: 'cpp',
  dockerfile: 'docker',
  golang: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  js: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  mjs: 'javascript',
  pl: 'perl',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  svg: 'xml',
  tf: 'terraform',
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

/** Long transcripts keep a bounded number of block highlights. */
const MAX_CACHED_HIGHLIGHTS = 96

/** A chunk that failed to load is transient, so failed entries retry once quiet. */
const FAILED_HIGHLIGHT_RETRY_MS = 5_000

/**
 * Completed highlights keyed by grammar and exact code text. A streaming
 * conversation re-renders on every delta, so without this cache each delta would
 * re-tokenize every visible block on the Webview main thread. `null` records a
 * failed attempt, which keeps that block as plaintext until the retry timer
 * clears the entry.
 */
const codeHighlights = new Map<string, string | null>()
const pendingHighlights = new Map<string, Promise<void>>()
const highlightListeners = new Set<() => void>()
let highlightVersion = 0
let failedHighlightRetry: ReturnType<typeof setTimeout> | undefined

/** Subscribe to cache completions; the version changes whenever one lands. */
export function subscribeCodeHighlights(listener: () => void): () => void {
  highlightListeners.add(listener)
  return () => {
    highlightListeners.delete(listener)
  }
}

export function codeHighlightVersion(): number {
  return highlightVersion
}

/**
 * Highlight for exactly this code text, `null` when the attempt failed, or
 * `undefined` while nothing has been attempted for it. Reading never starts
 * work, so callers can compose a render synchronously and let
 * {@link subscribeCodeHighlights} report when a highlight becomes readable.
 */
export function cachedCodeHighlight(language: WebviewLanguage, code: string): string | null | undefined {
  return codeHighlights.get(highlightKey(language, code))
}

/** Highlight `code` in the background and cache the result. */
export function requestCodeHighlight(language: WebviewLanguage, code: string): void {
  const key = highlightKey(language, code)
  if (codeHighlights.has(key) || pendingHighlights.has(key)) return
  const request = renderCodeHighlight(language, code)
    .then(
      (html) => {
        storeCodeHighlight(key, html)
      },
      () => {
        storeCodeHighlight(key, null)
      },
    )
    .finally(() => {
      pendingHighlights.delete(key)
    })
  pendingHighlights.set(key, request)
}

function highlightKey(language: WebviewLanguage, code: string): string {
  return `${language}\u0000${code}`
}

function storeCodeHighlight(key: string, html: string | null): void {
  codeHighlights.delete(key)
  codeHighlights.set(key, html)
  while (codeHighlights.size > MAX_CACHED_HIGHLIGHTS) {
    const oldest = codeHighlights.keys().next().value
    if (oldest === undefined) break
    codeHighlights.delete(oldest)
  }
  if (html === null) scheduleFailedHighlightRetry()
  notifyHighlights()
}

/**
 * Grammar chunks fail once and load on a later attempt. Clearing the failed
 * entries lets the next render ask again instead of leaving those blocks as
 * plaintext for the rest of the session.
 */
function scheduleFailedHighlightRetry(): void {
  failedHighlightRetry ??= setTimeout(() => {
    failedHighlightRetry = undefined
    for (const [key, html] of codeHighlights) {
      if (html === null) codeHighlights.delete(key)
    }
    notifyHighlights()
  }, FAILED_HIGHLIGHT_RETRY_MS)
}

function notifyHighlights(): void {
  highlightVersion += 1
  for (const listener of highlightListeners) listener()
}

async function renderCodeHighlight(language: WebviewLanguage, code: string): Promise<string> {
  const highlighter = await getWebviewHighlighter()
  await highlighter.loadLanguage(language)
  return highlighter.codeToHtml(code, {
    lang: language,
    themes: SHIKI_THEMES,
    defaultColor: 'light-dark()',
    // The surrounding Markdown CSS owns the surface. Shiki's default root
    // background is an opaque theme color and would otherwise turn a light
    // Webview code block into a dark rectangle.
    rootStyle: false,
  })
}
