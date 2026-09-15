import { useRef, useState, type ReactElement } from 'react'
import type { EditorContextItem, EditorContextPreview } from '@dsh-vscode/domain'

import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface EditorContextChipsProps {
  readonly items: readonly EditorContextItem[]
  readonly disabled: boolean
  readonly loading?: boolean
  readonly onRemove: (contextRef: string) => Promise<void> | void
  readonly onPreview: (contextRef: string) => Promise<EditorContextPreview | undefined>
}

/**
 * Composer-owned context chips. The component intentionally receives metadata
 * only; preview text is fetched into ephemeral local state after an explicit
 * click and is never persisted.
 */
export function EditorContextChips(props: EditorContextChipsProps): ReactElement {
  const { t } = useI18n()
  const [preview, setPreview] = useState<EditorContextPreview | undefined>()
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const [removeError, setRemoveError] = useState(false)
  const chipsRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  // Removing the chip also retires its preview: the dialog would otherwise keep
  // showing text for a context the composer no longer sends.
  const visiblePreview =
    preview !== undefined && props.items.some((item) => item.ref.contextRef === preview.contextRef)
      ? preview
      : undefined
  const closePreview = (): void => {
    setPreview(undefined)
    setPreviewError(false)
  }
  useDismissibleLayer({
    open: visiblePreview !== undefined,
    refs: [chipsRef, previewRef],
    onDismiss: closePreview,
  })
  const previewItem = (item: EditorContextItem): void => {
    if (props.disabled || item.stale || !item.previewAvailable || previewLoading) return
    setPreviewLoading(true)
    setPreviewError(false)
    void Promise.resolve()
      .then(() => props.onPreview(item.ref.contextRef))
      .then((result) => setPreview(result))
      .catch(() => {
        setPreview(undefined)
        setPreviewError(true)
      })
      .finally(() => setPreviewLoading(false))
  }

  if (props.items.length === 0 && props.loading !== true) return <></>
  return (
    <>
      <div ref={chipsRef} className="dsh-composer__context-chips">
        {props.loading === true ? (
          <span className="dsh-composer__context-status" role="status">
            {t('composer.contextLoading')}
          </span>
        ) : null}
        {props.items.map((item) => {
          const label = item.label.trim() === '' ? item.ref.relativePath : item.label
          return (
            <span
              className={`dsh-composer__context-chip${item.stale ? ' dsh-composer__context-chip--stale' : ''}`}
              key={item.ref.contextRef}
              title={item.stale ? t('composer.contextStale') : label}
            >
              <button
                className="dsh-composer__context-preview"
                type="button"
                disabled={props.disabled || item.stale || !item.previewAvailable || previewLoading}
                aria-label={t('composer.contextPreview', { name: label })}
                onClick={() => previewItem(item)}
              >
                <Icon name={item.stale ? 'alert' : editorContextIcon(item.ref.kind)} />
                <span>{label}</span>
                <small>{t('composer.contextBytes', { size: item.ref.sizeBytes })}</small>
              </button>
              <button
                className="dsh-icon-button dsh-composer__context-remove"
                type="button"
                aria-label={t('composer.contextRemove', { name: label })}
                disabled={props.disabled}
                onClick={() =>
                  void Promise.resolve()
                    .then(() => props.onRemove(item.ref.contextRef))
                    .then(() => setRemoveError(false))
                    .catch(() => setRemoveError(true))
                }
              >
                <Icon name="close" />
              </button>
            </span>
          )
        })}
        {removeError ? (
          <span className="dsh-composer__context-status dsh-composer__context-status--error" role="alert">
            {t('composer.contextActionError')}
          </span>
        ) : null}
      </div>
      {previewLoading ? (
        <div className="dsh-composer__context-preview-loading" role="status">
          {t('composer.contextPreviewLoading')}
        </div>
      ) : null}
      {previewError ? (
        <div className="dsh-composer__context-preview-loading" role="status">
          {t('composer.contextPreviewError')}
        </div>
      ) : null}
      {visiblePreview === undefined ? null : (
        <div
          ref={previewRef}
          className="dsh-composer__context-preview-dialog"
          role="dialog"
          aria-label={t('composer.contextPreviewTitle')}
        >
          <div className="dsh-composer__context-preview-header">
            <strong>{t('composer.contextPreviewTitle')}</strong>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('composer.contextPreviewClose')}
              onClick={closePreview}
            >
              <Icon name="close" />
            </button>
          </div>
          <pre>{visiblePreview.text}</pre>
        </div>
      )}
    </>
  )
}

function editorContextIcon(kind: EditorContextItem['ref']['kind']): 'edit' | 'file' | 'alert' | 'target' {
  switch (kind) {
    case 'selection':
      return 'edit'
    case 'file':
      return 'file'
    case 'diagnostic':
      return 'alert'
    case 'symbol':
      return 'target'
  }
}
