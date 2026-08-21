import MarkdownIt from 'markdown-it'
import * as katex from 'katex'
import texmath from 'markdown-it-texmath'
import { createRoot, type Root } from 'react-dom/client'
import { createHighlighter, type BundledLanguage } from 'shiki'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { useI18n } from '../../i18n.js'
import { CopyButton } from './CopyButton.js'
import 'katex/dist/katex.min.css'

const markdownRenderer = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
  typographer: false,
})

// Model output is untrusted UI input. Keep raw HTML and remote images out of the
// webview while retaining the common Markdown used in conversations.
markdownRenderer.disable(['image'])
markdownRenderer.use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: {
    // Model output is untrusted. KaTeX's generated markup is safe when macro
    // expansion and HTML trust are disabled; malformed TeX falls back to a
    // visible error instead of aborting the whole message.
    throwOnError: false,
    trust: false,
    output: 'htmlAndMathml',
  },
})

export interface MarkdownContentProps {
  readonly markdown: string
  /** Streaming messages render completed blocks separately from the tail. */
  readonly streaming?: boolean
  readonly onOpenLink?: ((href: string) => void) | undefined
  /** Successful mutation paths from the closing assistant turn. */
  readonly producedFiles?: readonly string[]
}

export function MarkdownContent({
  markdown,
  streaming = false,
  onOpenLink,
  producedFiles = [],
}: MarkdownContentProps): ReactElement {
  const { t } = useI18n()
  const contentRef = useRef<HTMLDivElement>(null)
  const rawHtml = useMemo(() => renderMarkdownDocument(markdown, streaming), [markdown, streaming])
  const [highlightedHtml, setHighlightedHtml] = useState<
    { readonly source: string; readonly html: string } | undefined
  >(undefined)

  // Shiki is intentionally loaded only after the first code block is present.
  // A language is then loaded on demand and cached by the shared highlighter.
  // This keeps the initial Webview bundle usable for ordinary chat messages.
  useEffect(() => {
    let cancelled = false
    void highlightMarkdownHtml(rawHtml).then((html) => {
      if (!cancelled) setHighlightedHtml({ source: rawHtml, html })
    })
    return () => {
      cancelled = true
    }
  }, [rawHtml])

  useEffect(() => {
    const container = contentRef.current
    if (container === null) return

    const mounted: MountedCopyRegion[] = []
    for (const target of Array.from(container.querySelectorAll<HTMLElement>('pre, table'))) {
      if (target.parentElement?.classList.contains('dsh-markdown__copy-region')) continue

      const region = document.createElement('div')
      const kind = target.tagName.toLowerCase() === 'table' ? 'table' : 'code'
      region.className = `dsh-markdown__copy-region dsh-markdown__copy-region--${kind}`
      const mount = document.createElement('span')
      mount.className = 'dsh-markdown__copy-mount'
      target.replaceWith(region)
      region.append(target, mount)

      const root = createRoot(mount)
      root.render(
        <CopyButton text={copyableMarkdown(target)} className="dsh-markdown__copy-button" translate={t} />,
      )
      mounted.push({ root, region, target })
    }

    const mentions: MountedFileMention[] = []
    if (onOpenLink !== undefined && producedFiles.length > 0) {
      for (const code of Array.from(container.querySelectorAll<HTMLElement>('code'))) {
        // Fenced blocks are copied as a unit and must never turn individual
        // source-code tokens into file-open actions.
        if (code.closest('pre') !== null) continue
        const value = code.textContent ?? ''
        const path = resolveProducedPath(producedFiles, value)
        if (path === undefined) continue

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-markdown__file-mention'
        button.title = path
        button.setAttribute('aria-label', t('timeline.openProduced', { name: path }))
        button.textContent = value
        const handleClick = (): void => onOpenLink(path)
        button.addEventListener('click', handleClick)
        code.replaceWith(button)
        mentions.push({ button, code, handleClick })
      }
    }

    return () => {
      for (const mention of mentions) {
        mention.button.removeEventListener('click', mention.handleClick)
        if (mention.button.parentNode !== null) mention.button.replaceWith(mention.code)
      }
      for (const entry of mounted) {
        entry.root.unmount()
        if (entry.region.parentNode !== null && entry.region.contains(entry.target))
          entry.region.replaceWith(entry.target)
      }
    }
  }, [markdown, onOpenLink, producedFiles, t])

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (onOpenLink === undefined) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a')
    const href = anchor?.getAttribute('href')
    if (href === null || href === undefined || href.startsWith('#')) return
    event.preventDefault()
    onOpenLink(href)
  }

  return (
    <div
      ref={contentRef}
      className={`dsh-markdown${streaming ? ' dsh-markdown--streaming' : ''}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{
        __html: highlightedHtml?.source === rawHtml ? highlightedHtml.html : rawHtml,
      }}
    />
  )
}

type MarkdownHighlighter = Awaited<ReturnType<typeof createHighlighter>>

let highlighterPromise: Promise<MarkdownHighlighter> | undefined

function getMarkdownHighlighter(): Promise<MarkdownHighlighter> {
  highlighterPromise ??= createHighlighter({ themes: ['github-dark'], langs: [] })
  return highlighterPromise
}

function renderMarkdownDocument(markdown: string, streaming: boolean): string {
  if (!streaming) return markdownRenderer.render(markdown)
  const blocks = splitMarkdownBlocks(markdown)
  if (blocks.length <= 1) return markdownRenderer.render(markdown)

  // The last non-blank block is the only block that can still change as a
  // delta arrives. Closed fenced blocks are stable even without a following
  // blank line, so they can be frozen immediately.
  const stableCount = stableBlockCount(markdown, blocks)
  if (stableCount === 0)
    return `<div data-dsh-markdown-tail="true">${markdownRenderer.render(markdown)}</div>`
  const frozen = blocks.slice(0, stableCount).join('\n\n')
  const tail = blocks.slice(stableCount).join('\n\n')
  return [
    `<div data-dsh-markdown-frozen="true">${markdownRenderer.render(frozen)}</div>`,
    tail === '' ? '' : `<div data-dsh-markdown-tail="true">${markdownRenderer.render(tail)}</div>`,
  ].join('')
}

function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const blocks: string[] = []
  const current: string[] = []
  let fence: '`' | '~' | undefined

  const flush = (): void => {
    if (current.length === 0) return
    blocks.push(current.join('\n'))
    current.length = 0
  }

  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)
    if (marker !== null) {
      const nextFence = marker[1]?.startsWith('~') === true ? '~' : '`'
      if (fence === undefined) fence = nextFence
      else if (nextFence === fence) fence = undefined
      current.push(line)
      continue
    }
    if (fence === undefined && line.trim() === '') flush()
    else current.push(line)
  }
  flush()
  return blocks
}

function stableBlockCount(markdown: string, blocks: readonly string[]): number {
  if (blocks.length === 0) return 0
  if (/\n\s*\n\s*$/u.test(markdown)) return blocks.length
  const last = blocks[blocks.length - 1] ?? ''
  if (/^\s*(`{3,}|~{3,})[\s\S]*\n\s*\1\s*$/u.test(last)) return blocks.length
  return Math.max(0, blocks.length - 1)
}

async function highlightMarkdownHtml(html: string): Promise<string> {
  if (!html.includes('language-') || typeof DOMParser === 'undefined') return html
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const codeBlocks = Array.from(parsed.body.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'))
  if (codeBlocks.length === 0) return html
  const highlighter = await getMarkdownHighlighter()
  let changed = false
  for (const code of codeBlocks) {
    const languageClass = Array.from(code.classList).find((value) => value.startsWith('language-'))
    const language = languageClass === undefined ? undefined : bundledLanguage(languageClass.slice(9))
    if (language === undefined) continue
    try {
      await highlighter.loadLanguage(language)
      const highlighted = highlighter.codeToHtml(code.textContent ?? '', {
        lang: language,
        theme: 'github-dark',
      })
      const template = parsed.createElement('template')
      template.innerHTML = highlighted
      const replacement = template.content.firstElementChild
      if (replacement !== null && code.parentElement !== null) {
        code.parentElement.replaceWith(replacement)
        changed = true
      }
    } catch {
      // Unknown grammars remain as safe Markdown plaintext. A failed lazy
      // language import must never remove or blank a user-visible code block.
    }
  }
  return changed ? parsed.body.innerHTML : html
}

function bundledLanguage(value: string): BundledLanguage | undefined {
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

interface MountedCopyRegion {
  readonly root: Root
  readonly region: HTMLDivElement
  readonly target: HTMLElement
}

interface MountedFileMention {
  readonly button: HTMLButtonElement
  readonly code: HTMLElement
  readonly handleClick: () => void
}

function resolveProducedPath(paths: readonly string[], value: string): string | undefined {
  if (paths.includes(value)) return value
  const matches = paths.filter((path) => producedFileBasename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}

function producedFileBasename(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return slash === -1 ? value : value.slice(slash + 1)
}

function copyableMarkdown(target: HTMLElement): string {
  if (target instanceof HTMLTableElement) {
    return Array.from(target.rows, (row) =>
      Array.from(row.cells, (cell) => cell.textContent?.trim() ?? '').join('\t'),
    ).join('\n')
  }
  return target.textContent ?? ''
}
