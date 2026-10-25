import { useLayoutEffect, type ReactElement, type RefObject } from 'react'
import type { PromptAttachment } from '@dsh-vscode/domain'
import { getAccessibilitySignals, subscribeAccessibilitySignals } from '../../app/accessibility-signals.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { pageAttachmentRail } from './composer-input.js'

/**
 * The composer's attachment chip rail with its horizontal paging buttons and
 * wheel-to-horizontal-scroll. Attachment state lives in the composer and the
 * lightbox hook; motion follows the shared accessibility subscription.
 */
export function ComposerAttachmentsRail({
  attachments,
  previews,
  railRef,
  scrollable,
  onOpenPreview,
  onRemove,
}: {
  readonly attachments: readonly PromptAttachment[]
  readonly previews: Readonly<Record<string, string>>
  readonly railRef: RefObject<HTMLUListElement | null>
  readonly scrollable: boolean
  readonly onOpenPreview: (uri: string, trigger: HTMLButtonElement) => void
  readonly onRemove: (uri: string) => void
}): ReactElement | null {
  const { t } = useI18n()
  useLayoutEffect(
    () =>
      subscribeAccessibilitySignals(() => {
        const rail = railRef.current
        if (rail !== null && getAccessibilitySignals().reducedMotion && typeof rail.scrollTo === 'function') {
          // CSS and future paging calls cannot cancel an already running
          // browser smooth scroll. Freeze it at its current position.
          rail.scrollTo({ left: rail.scrollLeft, behavior: 'instant' })
        }
      }),
    [railRef],
  )
  if (attachments.length === 0) return null
  return (
    <div className="dsh-composer__attachment-rail">
      {scrollable ? (
        <button
          className="dsh-composer__attachment-page"
          type="button"
          aria-label={t('composer.attachmentsPrevious')}
          onClick={() => pageAttachmentRail(railRef.current, -1)}
        >
          <Icon name="chevron-left" />
        </button>
      ) : null}
      <ul
        ref={railRef}
        className="dsh-composer__attachments"
        aria-label={t('composer.attachments')}
        onWheel={(event) => {
          const element = event.currentTarget
          if (event.deltaX === 0 && event.deltaY !== 0 && element.scrollWidth > element.clientWidth) {
            event.preventDefault()
            element.scrollLeft += event.deltaY
          }
        }}
      >
        {attachments.map((attachment) => {
          const isImage = attachment.mimeType?.startsWith('image/') === true
          const preview = previews[attachment.uri]
          return (
            <li className="dsh-composer__attachment dsh-composer__context-chip" key={attachment.uri}>
              <span className="dsh-composer__attachment-content">
                {isImage ? (
                  <button
                    className="dsh-composer__attachment-thumb"
                    type="button"
                    aria-label={t('composer.preview', { name: attachment.name })}
                    title={t('composer.preview', { name: attachment.name })}
                    onClick={(event) => {
                      onOpenPreview(attachment.uri, event.currentTarget)
                    }}
                  >
                    {preview === undefined ? (
                      <Icon name="image" />
                    ) : (
                      <img src={preview} alt="" aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <span className="dsh-composer__attachment-preview" aria-hidden="true">
                    <Icon name="file" />
                  </span>
                )}
                <span className="dsh-composer__attachment-name" title={attachment.name}>
                  file: {attachment.name}
                </span>
              </span>
              <button
                className="dsh-icon-button dsh-composer__context-remove dsh-composer__attachment-remove"
                type="button"
                aria-label={t('composer.remove', { name: attachment.name })}
                onClick={() => {
                  onRemove(attachment.uri)
                }}
              >
                <Icon name="close" />
              </button>
            </li>
          )
        })}
      </ul>
      {scrollable ? (
        <button
          className="dsh-composer__attachment-page"
          type="button"
          aria-label={t('composer.attachmentsNext')}
          onClick={() => pageAttachmentRail(railRef.current, 1)}
        >
          <Icon name="chevron-right" />
        </button>
      ) : null}
    </div>
  )
}
