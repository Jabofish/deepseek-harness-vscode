import type { ReactElement } from 'react'
import type { ReferenceCandidate } from '../../app/store.js'
import { useI18n } from '../../i18n.js'

export const REFERENCE_MENU_ID = 'dsh-reference-menu'

export function referenceMenuOptionId(index: number): string {
  return `dsh-reference-option-${index}`
}

export interface ReferencePaletteProps {
  readonly candidates: readonly ReferenceCandidate[]
  readonly loading: boolean
  readonly highlight?: number
  readonly onSelect: (candidate: ReferenceCandidate) => void
}

/** Host-backed `@` autocomplete. It only renders safe labels and mentions
 * projected by the Extension Host; the Webview never searches the filesystem. */
export function ReferencePalette(props: ReferencePaletteProps): ReactElement {
  const { t } = useI18n()
  return (
    <section className="dsh-command-palette dsh-reference-palette" id={REFERENCE_MENU_ID}>
      {props.loading ? (
        <p role="status">{t('composer.referencesLoading')}</p>
      ) : props.candidates.length === 0 ? (
        <p role="status">{t('composer.noReferences')}</p>
      ) : (
        <ul role="listbox" aria-label={t('composer.references')}>
          {(() => {
            let optionIndex = 0
            return [
              {
                label: t('composer.referencesFiles'),
                candidates: props.candidates.filter((candidate) => candidate.kind !== 'session'),
              },
              {
                label: t('composer.referencesSessions'),
                candidates: props.candidates.filter((candidate) => candidate.kind === 'session'),
              },
            ].flatMap((group) => {
              if (group.candidates.length === 0) return []
              const rows: ReactElement[] = [
                <li className="dsh-reference-palette__group" key={`group:${group.label}`} role="presentation">
                  {group.label}
                </li>,
              ]
              for (const candidate of group.candidates) {
                const index = optionIndex++
                const mention = candidate.kind === 'session' ? candidate.mention : fileMention(candidate)
                rows.push(
                  <li key={candidate.id}>
                    <button
                      id={referenceMenuOptionId(index)}
                      className={`dsh-command-palette__item dsh-reference-palette__item${
                        index === props.highlight ? ' dsh-command-palette__item--highlighted' : ''
                      }`}
                      type="button"
                      role="option"
                      aria-selected={index === props.highlight}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        props.onSelect(candidate)
                      }}
                    >
                      <strong>{candidate.label}</strong>
                      <span>{candidate.description}</span>
                      <small>{mention}</small>
                    </button>
                  </li>,
                )
              }
              return rows
            })
          })()}
        </ul>
      )}
    </section>
  )
}

function fileMention(
  candidate: Extract<ReferenceCandidate, { readonly kind: 'file' | 'directory' }>,
): string {
  const path =
    candidate.kind === 'directory' && !candidate.path.endsWith('/') ? `${candidate.path}/` : candidate.path
  return `@${/[\s"]/u.test(path) ? `"${path}"` : path}`
}
