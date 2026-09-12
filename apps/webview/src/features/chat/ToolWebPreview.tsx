import type { ReactElement } from 'react'
import type { ToolWebRenderProps } from '@dsh-vscode/ui'
import { useI18n } from '../../i18n.js'
import { MarkdownContent } from './MarkdownContent.js'

/**
 * Webview renderer for structured web search/fetch results. Answers use the
 * existing sanitized Markdown surface; URL activation stays a host callback,
 * so neither this card nor model-authored links create native navigation.
 */
export function ToolWebPreview(props: ToolWebRenderProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const translate = props.translate ?? defaultTranslate
  return props.view.kind === 'search' ? renderSearch(props, translate) : renderFetch(props, translate)
}

function renderSearch(
  props: ToolWebRenderProps,
  translate: NonNullable<ToolWebRenderProps['translate']>,
): ReactElement {
  const view = props.view
  if (view.kind !== 'search') return renderFetch(props, translate)
  const hasAnswer = view.answer !== undefined && view.answer.trim() !== ''
  const empty = !hasAnswer && view.sources.length === 0
  return (
    <div className="dsh-tool-web-preview" data-web="search">
      {hasAnswer ? (
        <div className="dsh-tool-web-preview__answer">
          <MarkdownContent markdown={view.answer ?? ''} onOpenLink={props.onOpenLink} />
        </div>
      ) : null}
      {empty ? (
        <div className="dsh-tool-web-preview__empty">{translate('toolrow.presentation.noResults')}</div>
      ) : (
        <ol className="dsh-tool-web-preview__sources">
          {view.sources.map((source, index) => (
            <li className="dsh-tool-web-preview__source" key={`${source.url}:${index}`}>
              {renderLink(source.url, source.title, props.onOpenLink)}
              {source.snippet !== undefined && source.snippet.trim() !== '' ? (
                <div className="dsh-tool-web-preview__snippet">{source.snippet}</div>
              ) : null}
              {source.publishedAt !== undefined && source.publishedAt.trim() !== '' ? (
                <time className="dsh-tool-web-preview__published">{source.publishedAt}</time>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {view.truncated ? (
        <div className="dsh-tool-web-preview__truncated">
          {translate('toolrow.presentation.sourcesTruncated')}
        </div>
      ) : null}
    </div>
  )
}

function renderFetch(
  props: ToolWebRenderProps,
  translate: NonNullable<ToolWebRenderProps['translate']>,
): ReactElement {
  const view = props.view
  if (view.kind !== 'fetch') return <></>
  return (
    <div className="dsh-tool-web-preview dsh-tool-web-preview--fetch" data-web="fetch">
      {renderLink(view.url, view.url, props.onOpenLink, true)}
      <div className="dsh-tool-web-preview__fetch-meta">
        <span>
          {translate('toolrow.presentation.http')} {view.statusCode}
        </span>
        {view.truncated ? (
          <span className="dsh-tool-web-preview__truncated">
            {translate('toolrow.presentation.contentTruncated')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function renderLink(
  url: string,
  title: string | undefined,
  onOpenLink: ((href: string) => void) | undefined,
  showUrl = false,
): ReactElement {
  const label = showUrl ? url : linkLabel(url, title)
  const openable = onOpenLink !== undefined && isHttpUrl(url)
  if (!openable)
    return (
      <span className="dsh-tool-web-preview__link" title={url}>
        {label}
      </span>
    )
  return (
    <button
      type="button"
      className="dsh-tool-web-preview__link dsh-tool-web-preview__link--interactive"
      title={url}
      aria-label={label}
      onClick={() => onOpenLink(url)}
    >
      {label}
    </button>
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function linkLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.trim() !== '') return title
  try {
    const hostname = new URL(url).hostname
    return hostname === '' ? url : hostname
  } catch {
    return url
  }
}
