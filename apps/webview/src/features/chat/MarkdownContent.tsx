import MarkdownIt from 'markdown-it'
import * as katex from 'katex'
import texmath from 'markdown-it-texmath'
import { createRoot, type Root } from 'react-dom/client'
import {
  useDeferredValue,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { useI18n } from '../../i18n.js'
import { CopyButton } from './CopyButton.js'
import { ContentFlow } from '../../components/common/ContentFlow.js'
import { getWebviewHighlighter, resolveBundledLanguage, SHIKI_THEMES } from './shiki.js'
import 'katex/dist/katex.min.css'

const STREAMING_HIGHLIGHT_DEBOUNCE_MS = 120
const STREAMING_MARKDOWN_DEFER_THRESHOLD = 4_096

const markdownRenderer = new MarkdownIt({
  // Model output often contains soft-wrapped source lines. Standard Markdown
  // whitespace keeps those wraps from becoming accidental visual line breaks;
  // explicit hard breaks and blank lines still retain their meaning.
  breaks: false,
  html: false,
  linkify: false,
  typographer: false,
})

// Markdown is model-authored content. Do not leave a native href in the
// Webview: a browser navigation must never happen before the extension host
// has received an explicit user gesture and applied its own policy.
markdownRenderer.renderer.rules.link_open = (tokens, index, options, _env, self): string => {
  const token = tokens[index]
  const href = token?.attrGet('href')
  if (token === undefined || href === null || href === undefined || href.startsWith('#')) {
    return self.renderToken(tokens, index, options)
  }

  token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'href')
  token.attrSet('data-dsh-link', href)
  token.attrSet('role', 'link')
  token.attrSet('tabindex', '0')
  return self.renderToken(tokens, index, options)
}

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

export const MarkdownContent = memo(function MarkdownContent({
  markdown,
  streaming = false,
  onOpenLink,
  producedFiles = [],
}: MarkdownContentProps): ReactElement {
  const { t } = useI18n()
  const contentRef = useRef<HTMLDivElement>(null)
  const markdownProjector = useMemo(() => createMarkdownProjector(), [])
  // MarkdownIt reparses the accumulated stream. Let React keep the latest
  // input authoritative while lowering render priority for long messages so
  // rapid deltas do not monopolize the Webview main thread. Short messages
  // remain synchronous for responsive first paint and deterministic tail UI.
  const deferredMarkdown = useDeferredValue(markdown)
  const markdownForRender =
    streaming && markdown.length > STREAMING_MARKDOWN_DEFER_THRESHOLD ? deferredMarkdown : markdown
  const rawHtml = useMemo(
    () => markdownProjector(markdownForRender, streaming),
    [markdownForRender, markdownProjector, streaming],
  )
  const [highlightedHtml, setHighlightedHtml] = useState<
    { readonly source: string; readonly html: string } | undefined
  >(undefined)

  // Shiki is intentionally loaded only after the first code block is present.
  // A language is then loaded on demand and cached by the shared highlighter.
  // This keeps the initial Webview bundle usable for ordinary chat messages.
  useEffect(() => {
    let cancelled = false
    if (!rawHtml.includes('language-')) return
    const highlight = (): void => {
      void highlightMarkdownHtml(rawHtml).then((html) => {
        // Avoid a no-op state update for ordinary Markdown. It would tear down
        // the DOM-mounted copy regions once and recreate them on the next
        // effect pass, which can race React roots while a table is classified.
        if (!cancelled && html !== rawHtml) setHighlightedHtml({ source: rawHtml, html })
      })
    }
    // Streaming deltas can arrive faster than Shiki can parse a code block.
    // Let a quiet stream settle before highlighting, while the terminal
    // render remains eager so completed messages do not wait on this debounce.
    const timer = window.setTimeout(highlight, streaming ? STREAMING_HIGHLIGHT_DEBOUNCE_MS : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [rawHtml, streaming])

  useEffect(() => {
    const container = contentRef.current
    if (container === null) return
    if (streaming) return

    const mounted: MountedCopyRegion[] = []
    for (const target of Array.from(container.querySelectorAll<HTMLElement>('pre, table'))) {
      if (target.parentElement?.classList.contains('dsh-markdown__copy-region')) continue

      const region = document.createElement('div')
      const kind = target.tagName.toLowerCase() === 'table' ? 'table' : 'code'
      region.className = `dsh-markdown__copy-region dsh-markdown__copy-region--${kind}`
      if (kind === 'table') {
        const columns = target.querySelector<HTMLTableRowElement>('tr')?.cells.length ?? 0
        const wide = columns >= 4 && target.closest('blockquote') === null
        region.classList.add(
          wide ? 'dsh-markdown__copy-region--table-wide' : 'dsh-markdown__copy-region--table-fill',
        )
        if (wide) {
          // Keep the copy action in the fixed region while only the table
          // itself participates in horizontal scrolling.
          const scrollPort = document.createElement('div')
          scrollPort.className = 'dsh-markdown__table-scroll'
          scrollPort.tabIndex = 0
          target.replaceWith(region)
          scrollPort.append(target)
          region.append(scrollPort)
        } else {
          target.replaceWith(region)
          region.append(target)
        }
      } else {
        target.replaceWith(region)
        region.append(target)
      }
      const mount = document.createElement('span')
      mount.className = 'dsh-markdown__copy-mount'
      region.append(mount)

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
        button.className = 'dsh-inline-reference'
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
  }, [markdown, onOpenLink, producedFiles, rawHtml, highlightedHtml, streaming, t])

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest<HTMLElement>('[data-dsh-link]')
    const href = link?.getAttribute('data-dsh-link')
    if (href === null || href === undefined || href.trim() === '') return
    event.preventDefault()
    onOpenLink?.(href)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest<HTMLElement>('[data-dsh-link]')
    const href = link?.getAttribute('data-dsh-link')
    if (href === null || href === undefined || href.trim() === '') return
    event.preventDefault()
    onOpenLink?.(href)
  }

  return (
    <ContentFlow
      ref={contentRef}
      className={`dsh-markdown${streaming ? ' dsh-markdown--streaming' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      dangerouslySetInnerHTML={{
        __html: highlightedHtml?.source === rawHtml ? highlightedHtml.html : rawHtml,
      }}
    />
  )
})

function createMarkdownProjector(): (markdown: string, streaming: boolean) => string {
  let previousFrozenSource: string | undefined
  let previousFrozenHtml: string | undefined
  let previousStreamingMarkdown: string | undefined
  let previousStreamingBlocks: readonly string[] | undefined

  return (markdown, streaming) => {
    if (!streaming) {
      previousStreamingMarkdown = undefined
      previousStreamingBlocks = undefined
      return markdownRenderer.render(markdown)
    }
    const blocks =
      previousStreamingMarkdown === undefined || previousStreamingBlocks === undefined
        ? splitMarkdownBlocks(markdown)
        : (appendStreamingBlock(previousStreamingMarkdown, previousStreamingBlocks, markdown) ??
          splitMarkdownBlocks(markdown))
    previousStreamingMarkdown = markdown
    previousStreamingBlocks = blocks
    if (blocks.length <= 1) return markdownRenderer.render(markdown)

    // The last non-blank block is the only block that can still change as a
    // delta arrives. Closed fenced blocks are stable even without a following
    // blank line, so they can be frozen immediately.
    const stableCount = stableBlockCount(markdown, blocks)
    if (stableCount === 0)
      return `<div data-dsh-markdown-tail="true">${markdownRenderer.render(markdown)}</div>`

    const frozen = blocks.slice(0, stableCount).join('\n\n')
    const tail = blocks.slice(stableCount).join('\n\n')
    if (previousFrozenSource !== frozen) {
      previousFrozenSource = frozen
      previousFrozenHtml = markdownRenderer.render(frozen)
    }
    return [
      `<div data-dsh-markdown-frozen="true">${previousFrozenHtml ?? ''}</div>`,
      tail === '' ? '' : `<div data-dsh-markdown-tail="true">${markdownRenderer.render(tail)}</div>`,
    ].join('')
  }
}

/**
 * Most model deltas extend the current line. Reuse the already split block
 * prefix for that path; any newline can change paragraph/fence boundaries, so
 * those updates intentionally fall back to the complete splitter.
 */
function appendStreamingBlock(
  previousMarkdown: string,
  previousBlocks: readonly string[],
  nextMarkdown: string,
): readonly string[] | undefined {
  if (!nextMarkdown.startsWith(previousMarkdown)) return undefined
  if (nextMarkdown === previousMarkdown) return previousBlocks
  const appended = nextMarkdown.slice(previousMarkdown.length)
  if (appended.includes('\r') || appended.includes('\n') || /\n[ \t]*$/u.test(previousMarkdown))
    return undefined
  const last = previousBlocks[previousBlocks.length - 1]
  if (last === undefined) return undefined
  return [...previousBlocks.slice(0, -1), `${last}${appended}`]
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
  const highlighter = await getWebviewHighlighter()
  let changed = false
  for (const code of codeBlocks) {
    const languageClass = Array.from(code.classList).find((value) => value.startsWith('language-'))
    const language = languageClass === undefined ? undefined : resolveBundledLanguage(languageClass.slice(9))
    if (language === undefined) continue
    try {
      await highlighter.loadLanguage(language)
      const highlighted = highlighter.codeToHtml(code.textContent ?? '', {
        lang: language,
        themes: SHIKI_THEMES,
        defaultColor: 'light-dark()',
        // The surrounding Markdown CSS owns the surface. Shiki's default
        // root background is an opaque theme color and would otherwise turn
        // a light Webview code block into a dark rectangle.
        rootStyle: false,
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
