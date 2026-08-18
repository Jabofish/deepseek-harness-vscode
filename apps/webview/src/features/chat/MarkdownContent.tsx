import MarkdownIt from 'markdown-it'
import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useRef, type MouseEvent, type ReactElement } from 'react'
import { useI18n } from '../../i18n.js'
import { CopyButton } from './CopyButton.js'

const markdownRenderer = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
  typographer: false,
})

// Model output is untrusted UI input. Keep raw HTML and remote images out of the
// webview while retaining the common Markdown used in conversations.
markdownRenderer.disable(['image'])

export interface MarkdownContentProps {
  readonly markdown: string
  readonly onOpenLink?: ((href: string) => void) | undefined
}

export function MarkdownContent({ markdown, onOpenLink }: MarkdownContentProps): ReactElement {
  const { t } = useI18n()
  const contentRef = useRef<HTMLDivElement>(null)

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

    return () => {
      for (const entry of mounted) {
        entry.root.unmount()
        if (entry.region.parentNode !== null && entry.region.contains(entry.target))
          entry.region.replaceWith(entry.target)
      }
    }
  }, [markdown, t])

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
      className="dsh-markdown"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: markdownRenderer.render(markdown) }}
    />
  )
}

interface MountedCopyRegion {
  readonly root: Root
  readonly region: HTMLDivElement
  readonly target: HTMLElement
}

function copyableMarkdown(target: HTMLElement): string {
  if (target instanceof HTMLTableElement) {
    return Array.from(target.rows, (row) =>
      Array.from(row.cells, (cell) => cell.textContent?.trim() ?? '').join('\t'),
    ).join('\n')
  }
  return target.textContent ?? ''
}
