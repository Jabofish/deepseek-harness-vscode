import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { ThemedTokenWithVariants } from 'shiki'
import type { ToolCodeRenderProps } from '@dsh-vscode/ui'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'
import { getWebviewHighlighter, resolveBundledLanguage, SHIKI_THEMES, type WebviewLanguage } from './shiki.js'

const DEFAULT_MAX_LINES = 16
const MAX_HIGHLIGHT_SOURCE_LENGTH = 64_000

/**
 * Webview-owned renderer for the shared ToolRow read contract. The shared UI
 * supplies line numbers and a safe plaintext fallback; this layer adds the
 * upstream ReadBlock affordances without making packages/ui depend on Shiki.
 */
export function ToolCodePreview(props: ToolCodeRenderProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const translate = props.translate ?? defaultTranslate
  const source = useMemo(() => props.lines.map((line) => line.text).join('\n'), [props.lines])
  const language = useMemo(() => resolveBundledLanguage(props.language), [props.language])
  const rootRef = useRef<HTMLDivElement>(null)
  const [activated, setActivated] = useState(() => typeof IntersectionObserver === 'undefined')
  const [highlighted, setHighlighted] = useState<HighlightedCode | undefined>(undefined)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (activated || language === undefined || source.length > MAX_HIGHLIGHT_SOURCE_LENGTH) return
    const target = rootRef.current
    if (target === null || typeof IntersectionObserver === 'undefined') {
      setActivated(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setActivated(true)
      },
      { rootMargin: '240px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [activated, language, source.length])

  useEffect(() => {
    let cancelled = false
    if (
      !activated ||
      language === undefined ||
      source.length === 0 ||
      source.length > MAX_HIGHLIGHT_SOURCE_LENGTH
    )
      return

    void getWebviewHighlighter()
      .then(async (highlighter) => {
        await highlighter.loadLanguage(language)
        const tokens = highlighter.codeToTokensWithThemes(source, {
          lang: language,
          themes: SHIKI_THEMES,
        })
        if (!cancelled) setHighlighted({ language, source, tokens })
      })
      .catch(() => {
        // A missing grammar or a Shiki failure must retain the visible
        // plaintext rows rather than blanking a tool result.
        if (!cancelled) setHighlighted(undefined)
      })

    return () => {
      cancelled = true
    }
  }, [activated, language, source])

  const hidden = Math.max(0, props.lines.length - DEFAULT_MAX_LINES)
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(DEFAULT_MAX_LINES / 2)
  const tailLines = DEFAULT_MAX_LINES - headLines
  const highlightedSource =
    highlighted !== undefined && highlighted.language === language && highlighted.source === source
      ? highlighted.tokens
      : undefined
  const hasToolbarMeta = props.lines.length < props.totalLines || (props.language?.trim() ?? '') !== ''
  const showCopy = props.lines.length > 0
  const renderRows = (lines: ToolCodeRenderProps['lines'], startIndex: number): ReactElement[] =>
    lines.map((line, index) => {
      const sourceIndex = startIndex + index
      const tokenLine = highlightedSource?.[sourceIndex]
      return (
        <span className="dsh-tool-code-preview__line" key={`${line.number}:${sourceIndex}`}>
          <span className="dsh-sr-only">
            {line.number}: {line.text}
          </span>
          <span className="dsh-tool-code-preview__line-number" aria-hidden="true">
            {line.number}:
          </span>
          <code aria-hidden="true">
            {tokenLine === undefined
              ? line.text
              : tokenLine.map((token, tokenIndex) => (
                  <span
                    className="dsh-tool-code-preview__token"
                    key={`${token.offset}:${tokenIndex}`}
                    style={tokenStyle(token)}
                  >
                    {token.content}
                  </span>
                ))}
          </code>
        </span>
      )
    })

  return (
    <div
      ref={rootRef}
      className="dsh-tool-code-preview"
      data-read=""
      data-language={props.language ?? 'text'}
    >
      {hasToolbarMeta || showCopy ? (
        <div
          className={`dsh-tool-code-preview__toolbar${hasToolbarMeta ? '' : ' dsh-tool-code-preview__toolbar--minimal'}`}
        >
          <span className="dsh-tool-code-preview__window">
            {props.lines.length < props.totalLines
              ? translate('toolrow.presentation.window', {
                  shown: props.lines.length,
                  total: props.totalLines,
                })
              : null}
          </span>
          <span className="dsh-tool-code-preview__language">{props.language ?? ''}</span>
          {showCopy ? (
            <CopyButton text={source} className="dsh-tool-code-preview__copy" translate={translate} />
          ) : null}
        </div>
      ) : null}
      <pre
        className="dsh-tool-code-preview__body"
        data-highlighted={highlightedSource === undefined ? 'false' : 'true'}
      >
        {capped ? renderRows(props.lines.slice(0, headLines), 0) : renderRows(props.lines, 0)}
        {hidden > 0 ? (
          <button
            type="button"
            className="dsh-tool-code-preview__fold"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? translate('toolrow.presentation.collapseLines')
                : translate('toolrow.presentation.expandLines', { count: hidden })
            }
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? translate('toolrow.presentation.collapseLines')
              : translate('toolrow.presentation.expandLines', { count: hidden })}
          </button>
        ) : null}
        {capped
          ? renderRows(props.lines.slice(props.lines.length - tailLines), props.lines.length - tailLines)
          : null}
      </pre>
    </div>
  )
}

interface HighlightedCode {
  readonly language: WebviewLanguage
  readonly source: string
  readonly tokens: readonly (readonly ThemedTokenWithVariants[])[]
}

function tokenStyle(token: ThemedTokenWithVariants): CSSProperties {
  const light = token.variants[SHIKI_THEMES.light]
  const dark = token.variants[SHIKI_THEMES.dark]
  const style: CSSProperties & Record<string, string> = {}
  if (light?.color !== undefined && dark?.color !== undefined)
    style.color = `light-dark(${light.color}, ${dark.color})`
  else if (light?.color !== undefined) style.color = light.color
  else if (dark?.color !== undefined) style.color = dark.color
  if (light?.bgColor !== undefined && dark?.bgColor !== undefined)
    style.backgroundColor = `light-dark(${light.bgColor}, ${dark.bgColor})`
  else if (light?.bgColor !== undefined) style.backgroundColor = light.bgColor
  else if (dark?.bgColor !== undefined) style.backgroundColor = dark.bgColor
  const fontStyle = light?.fontStyle ?? dark?.fontStyle ?? 0
  if ((fontStyle & 1) !== 0) style.fontStyle = 'italic'
  if ((fontStyle & 2) !== 0) style.fontWeight = 'bold'
  const decorations: string[] = []
  if ((fontStyle & 4) !== 0) decorations.push('underline')
  if ((fontStyle & 8) !== 0) decorations.push('line-through')
  if (decorations.length > 0) style.textDecoration = decorations.join(' ')
  return style
}
