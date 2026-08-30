import { useRef, type ReactElement } from 'react'
import type { OpenFileCandidate } from '../../app/store.js'

import { PopoverCard } from '../../components/common/PopoverCard.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface ComposerAttachmentActionsProps {
  readonly disabled: boolean
  readonly attachmentsDisabled: boolean
  readonly openFileCandidates: readonly OpenFileCandidate[]
  readonly defaultOpenFileId: string | undefined
  readonly openFilePickerOpen: boolean
  readonly openFilePickerLoading: boolean
  readonly attachedOpenFileIds: readonly string[]
  readonly attachingOpenFileId?: string
  readonly onPickAttachment: () => void
  readonly onToggleOpenFilePicker: () => void
  readonly onSelectOpenFile: (candidateId: string) => void
}

/** Secondary composer actions. They live behind the single plus trigger. */
export function ComposerAttachmentActions(props: ComposerAttachmentActionsProps): ReactElement {
  const { t } = useI18n()
  const attachedOpenFileIds = new Set(props.attachedOpenFileIds)
  const openFileTriggerRef = useRef<HTMLButtonElement>(null)
  const openFilePickerRef = useRef<HTMLDivElement>(null)
  const openFilePickerPosition = useViewportMenuPosition({
    open: props.openFilePickerOpen,
    anchorRef: openFileTriggerRef,
    menuRef: openFilePickerRef,
    placement: 'above',
    align: 'start',
  })

  return (
    <div className="dsh-composer__attachment-actions">
      <button
        className="dsh-composer__extra-action"
        type="button"
        role="menuitem"
        aria-label={t('composer.attach')}
        disabled={props.disabled || props.attachmentsDisabled}
        onClick={props.onPickAttachment}
      >
        <Icon name="paperclip" />
        <span>{t('composer.attach')}</span>
      </button>
      <div className="dsh-composer__open-files">
        <button
          ref={openFileTriggerRef}
          className="dsh-composer__extra-action"
          type="button"
          role="menuitem"
          aria-label={t('composer.chooseOpenFile')}
          aria-expanded={props.openFilePickerOpen}
          aria-haspopup="listbox"
          disabled={props.disabled || props.attachmentsDisabled}
          onClick={props.onToggleOpenFilePicker}
        >
          <Icon name="file" />
          <span>{t('composer.chooseOpenFile')}</span>
        </button>
        {props.openFilePickerOpen ? (
          <PopoverCard
            ref={openFilePickerRef}
            className="dsh-open-file-picker"
            role="dialog"
            aria-label={t('composer.openFiles')}
            style={openFilePickerPosition}
          >
            <div className="dsh-open-file-picker__header">
              <span>{t('composer.openFiles')}</span>
              <button
                className="dsh-icon-button dsh-open-file-picker__close"
                type="button"
                aria-label={t('composer.closeOpenFiles')}
                onClick={props.onToggleOpenFilePicker}
              >
                <Icon name="close" />
              </button>
            </div>
            {props.openFilePickerLoading ? (
              <p className="dsh-open-file-picker__empty">{t('composer.loading')}</p>
            ) : props.openFileCandidates.length === 0 ? (
              <p className="dsh-open-file-picker__empty">{t('composer.noOpenFiles')}</p>
            ) : (
              <ul
                className="dsh-open-file-picker__list"
                role="listbox"
                aria-label={t('composer.openFiles')}
              >
                {props.openFileCandidates.map((candidate) => {
                  const attached = attachedOpenFileIds.has(candidate.id)
                  const attaching = props.attachingOpenFileId === candidate.id
                  const remembered = props.defaultOpenFileId === candidate.id
                  return (
                    <li key={candidate.id}>
                      <button
                        className={`dsh-open-file-picker__option${
                          remembered ? ' dsh-open-file-picker__option--remembered' : ''
                        }`}
                        type="button"
                        role="option"
                        aria-selected={remembered}
                        disabled={!candidate.supported || attached || props.attachingOpenFileId !== undefined}
                        onClick={() => props.onSelectOpenFile(candidate.id)}
                      >
                        <span className="dsh-open-file-picker__icon" aria-hidden="true">
                          <Icon name={candidate.mimeType?.startsWith('image/') === true ? 'image' : 'file'} />
                        </span>
                        <span className="dsh-open-file-picker__name" title={candidate.name}>
                          {candidate.name}
                        </span>
                        <span className="dsh-open-file-picker__status">
                          {attaching
                            ? t('composer.adding')
                            : attached
                              ? t('composer.added')
                              : !candidate.supported
                                ? t('composer.unsupported')
                                : candidate.active
                                  ? t('composer.current')
                                  : ''}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </PopoverCard>
        ) : null}
      </div>
    </div>
  )
}
