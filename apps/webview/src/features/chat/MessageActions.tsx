import { useState, type ReactElement } from 'react'
import type { MessageFeedbackRating } from '@dsh-vscode/domain'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { CopyButton } from './CopyButton.js'

export interface MessageActionsProps {
  readonly text: string
  readonly onBranch?: (() => void) | undefined
  readonly branchUnavailable?: boolean | undefined
  readonly feedbackRating?: MessageFeedbackRating | undefined
  readonly feedbackNote?: string | undefined
  readonly onFeedback?: ((rating: MessageFeedbackRating) => void) | undefined
  readonly onFeedbackNote?: ((note: string | undefined) => Promise<void> | void) | undefined
  readonly feedbackUnavailable?: boolean | undefined
  readonly translate?: Translate
}

/** Copy and branch controls shared by user and assistant transcript rows. */
export function MessageActions(props: MessageActionsProps): ReactElement {
  const { t } = useI18n()
  const translate = props.translate ?? t
  const branchUnavailable = props.branchUnavailable === true
  const feedbackUnavailable = props.feedbackUnavailable === true
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteError, setNoteError] = useState<string | undefined>()
  const saveNote = (): void => {
    if (props.onFeedbackNote === undefined) return
    setNoteSaving(true)
    setNoteError(undefined)
    const note = noteDraft.trim() === '' ? undefined : noteDraft
    void Promise.resolve(props.onFeedbackNote(note))
      .then(() => setNoteOpen(false))
      .catch(() => setNoteError(translate('app.error.feedback')))
      .finally(() => setNoteSaving(false))
  }
  return (
    <div className="dsh-message-actions" role="toolbar" aria-label={translate('message.actions')}>
      <CopyButton text={props.text} className="dsh-message-actions__button" translate={translate} />
      {props.onFeedback === undefined ? null : (
        <>
          <button
            className="dsh-message-actions__button dsh-message-actions__button--feedback-positive"
            type="button"
            aria-label={translate('message.feedbackPositive')}
            aria-pressed={props.feedbackRating === 'positive'}
            title={translate('message.feedbackPositive')}
            disabled={feedbackUnavailable}
            onClick={() => props.onFeedback?.('positive')}
          >
            <Icon name="thumb-up" />
          </button>
          <button
            className="dsh-message-actions__button dsh-message-actions__button--feedback-negative"
            type="button"
            aria-label={translate('message.feedbackNegative')}
            aria-pressed={props.feedbackRating === 'negative'}
            title={translate('message.feedbackNegative')}
            disabled={feedbackUnavailable}
            onClick={() => props.onFeedback?.('negative')}
          >
            <Icon name="thumb-down" />
          </button>
        </>
      )}
      {props.feedbackRating === undefined || props.onFeedbackNote === undefined ? null : (
        <span className="dsh-message-actions__note">
          <button
            className="dsh-message-actions__button dsh-message-actions__note-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={noteOpen}
            title={props.feedbackNote === undefined ? translate('message.feedbackNote') : props.feedbackNote}
            onClick={() => {
              setNoteError(undefined)
              if (!noteOpen) setNoteDraft(props.feedbackNote ?? '')
              setNoteOpen((current) => !current)
            }}
          >
            <span aria-hidden="true">{props.feedbackNote === undefined ? '＋' : '✎'}</span>
            <span className="dsh-sr-only">{translate('message.feedbackNote')}</span>
          </button>
          {noteOpen ? (
            <div
              className="dsh-message-actions__note-panel"
              role="dialog"
              aria-label={translate('message.feedbackNote')}
            >
              <textarea
                aria-label={translate('message.feedbackNote')}
                placeholder={translate('message.feedbackNotePlaceholder')}
                value={noteDraft}
                rows={3}
                maxLength={16_384}
                disabled={noteSaving}
                onChange={(event) => setNoteDraft(event.target.value)}
              />
              <div className="dsh-message-actions__note-buttons">
                <button type="button" disabled={noteSaving} onClick={saveNote}>
                  {translate('message.saveFeedbackNote')}
                </button>
                <button type="button" disabled={noteSaving} onClick={() => setNoteOpen(false)}>
                  {translate('message.cancelFeedbackNote')}
                </button>
              </div>
              {noteError === undefined ? null : <span role="status">{noteError}</span>}
            </div>
          ) : null}
        </span>
      )}
      {props.onBranch === undefined ? null : (
        <button
          className="dsh-message-actions__button"
          type="button"
          aria-label={translate('message.branch')}
          aria-disabled={branchUnavailable || undefined}
          title={branchUnavailable ? translate('message.branchUnavailable') : translate('message.branch')}
          onClick={branchUnavailable ? undefined : props.onBranch}
        >
          <Icon name="branch" />
        </button>
      )}
    </div>
  )
}
