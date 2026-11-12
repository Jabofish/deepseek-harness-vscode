import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { MarkdownContent } from '../chat/MarkdownContent.js'
import type { FrontmatterField } from './frontmatter-fields.js'
import { useI18n } from '../../i18n.js'
import './document-preview.css'

type FrontmatterParser = (source: string) => readonly FrontmatterField[] | undefined

let loadedParser: FrontmatterParser | undefined
let pendingParser: Promise<FrontmatterParser | undefined> | undefined

/**
 * Loads and caches the YAML frontmatter parser chunk so callers opening a
 * markdown preview overlay can prepare `<dl>` rows before first paint.
 */
export function preloadFrontmatterParser(): Promise<FrontmatterParser | undefined> {
  if (loadedParser !== undefined) return Promise.resolve(loadedParser)
  pendingParser ??= import('./frontmatter-fields.js')
    .then((module) => {
      loadedParser = module.parseFrontmatterFields
      return loadedParser
    })
    .catch(() => {
      pendingParser = undefined
      return undefined
    })
  return pendingParser
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u
export function splitDocumentFrontmatter(
  text: string,
): { readonly source: string; readonly body: string } | undefined {
  const match = FRONTMATTER.exec(text)
  return match === null ? undefined : { source: match[1] ?? '', body: text.slice(match[0].length) }
}
/** Receives only an explicitly requested, Host-redacted editor preview. */
export function MarkdownDocumentPreview(props: { readonly text: string }): ReactElement {
  const { t } = useI18n()
  const split = useMemo(() => splitDocumentFrontmatter(props.text), [props.text])
  const syncParsed = useMemo(() => {
    if (split === undefined || loadedParser === undefined) return undefined
    return { source: split.source, fields: loadedParser(split.source) }
  }, [split])
  const [parsed, setParsed] = useState<{
    readonly source: string
    readonly fields: readonly FrontmatterField[] | undefined
  }>()
  useEffect(() => {
    if (split === undefined || loadedParser !== undefined) return
    let current = true
    void preloadFrontmatterParser().then((parser) => {
      if (!current) return
      setParsed({ source: split.source, fields: parser?.(split.source) })
    })
    return () => {
      current = false
    }
  }, [split])
  const resolved = syncParsed ?? (parsed?.source === split?.source ? parsed : undefined)
  const fields = resolved?.fields
  return (
    <div className="dsh-document-preview">
      {split === undefined ? null : (
        <section aria-label={t('document.frontmatter')}>
          {fields === undefined ? (
            <pre>{split.source}</pre>
          ) : (
            <dl>
              {fields.map((field, index) => (
                <div key={index}>
                  <dt>{field.key}</dt>
                  <dd>{field.block ? <pre>{field.value}</pre> : field.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
      <MarkdownContent markdown={split?.body ?? props.text} />
    </div>
  )
}
