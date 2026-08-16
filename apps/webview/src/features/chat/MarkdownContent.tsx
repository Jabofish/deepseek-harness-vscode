import MarkdownIt from 'markdown-it'
import type { MouseEvent, ReactElement } from 'react'

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
      className="dsh-markdown"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: markdownRenderer.render(markdown) }}
    />
  )
}
