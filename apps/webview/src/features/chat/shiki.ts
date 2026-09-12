import type { BundledLanguage, Highlighter } from 'shiki'

export const SHIKI_THEMES = {
  light: 'github-light-default',
  dark: 'github-dark-default',
} as const

let highlighterPromise: Promise<Highlighter> | undefined

/** Lazily create one Webview highlighter and share its grammar cache. */
export function getWebviewHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki').then(({ createHighlighter }) =>
    createHighlighter({ themes: Object.values(SHIKI_THEMES), langs: [] }),
  )
  return highlighterPromise
}

/** Resolve the bounded language aliases used by Markdown and read cards. */
export function resolveBundledLanguage(value: string | undefined): BundledLanguage | undefined {
  if (value === undefined) return undefined
  const aliases: Readonly<Record<string, BundledLanguage>> = {
    bash: 'shell',
    cjs: 'javascript',
    cpp: 'cpp',
    cs: 'csharp',
    cxx: 'cpp',
    go: 'go',
    html: 'html',
    htm: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'jsx',
    md: 'markdown',
    py: 'python',
    python: 'python',
    ps: 'powershell',
    ps1: 'powershell',
    sh: 'shell',
    shell: 'shell',
    sql: 'sql',
    svg: 'xml',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'tsx',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'text' || normalized === 'plaintext') return undefined
  return aliases[normalized] ?? (normalized as BundledLanguage)
}
