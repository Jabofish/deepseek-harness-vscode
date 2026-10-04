import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { MarkdownContent } from '../chat/MarkdownContent.js'
import type { FrontmatterField } from './frontmatter-fields.js'
import { useI18n } from '../../i18n.js'
import './document-preview.css'

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
  const [parsed, setParsed] = useState<{
    readonly source: string
    readonly fields: readonly FrontmatterField[] | undefined
  }>()
  useEffect(() => {
    if (split === undefined) return
    let current = true
    void import('./frontmatter-fields.js')
      .then((module) => {
        const fields = module.parseFrontmatterFields(split.source)
        if (current) setParsed({ source: split.source, fields })
      })
      .catch(() => {
        if (current) setParsed({ source: split.source, fields: undefined })
      })
    return () => {
      current = false
    }
  }, [split])
  const fields = parsed?.source === split?.source ? parsed?.fields : undefined
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
