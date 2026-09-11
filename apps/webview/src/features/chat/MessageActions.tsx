import { createPortal } from 'react-dom'
import { useEffect, useId, useCallback, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { FeedbackCategory, MessageFeedbackItem, MessageFeedbackRating } from '@dsh-vscode/domain'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { CopyButton } from './CopyButton.js'

const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const satisfies readonly FeedbackCategory[]

export interface MessageActionsProps {
  readonly text: string
  readonly onBranch?: (() => void) | undefined
  readonly branchUnavailable?: boolean | undefined
  readonly feedbackRating?: MessageFeedbackRating | undefined
  readonly feedbackNote?: string | undefined
  readonly feedbackCategory?: FeedbackCategory | undefined
  /** Retracts the currently recorded rating when the selected control is clicked again. */
  readonly onFeedback?: ((rating: MessageFeedbackRating) => void) | undefined
  /** Persists a new or edited rating only after the feedback dialog is submitted. */
  readonly onFeedbackSubmit?:
    | ((
        rating: MessageFeedbackRating,
        note: string | undefined,
        category: FeedbackCategory | undefined,
      ) => Promise<void> | void)
    | undefined
  /** Seeds the session catalog before deciding whether this click retracts. */
  readonly onFeedbackPrepare?: () =>
    Promise<MessageFeedbackItem | undefined> | MessageFeedbackItem | undefined
  readonly feedbackUnavailable?: boolean | undefined
  readonly translate?: Translate
}

/** Copy, feedback, and branch controls shared by transcript rows. */
export function MessageActions(props: MessageActionsProps): ReactElement {
  const { t } = useI18n()
  const translate = props.translate ?? t
  const branchUnavailable = props.branchUnavailable === true
  const feedbackUnavailable = props.feedbackUnavailable === true
  const hasFeedback = props.onFeedback !== undefined || props.onFeedbackSubmit !== undefined
  const [dialogRating, setDialogRating] = useState<MessageFeedbackRating | undefined>()
  const [dialogDraft, setDialogDraft] = useState('')
  const [dialogCategory, setDialogCategory] = useState<FeedbackCategory | undefined>()
  const [feedbackPreparing, setFeedbackPreparing] = useState(false)
  const [dialogSaving, setDialogSaving] = useState(false)
  const [dialogError, setDialogError] = useState<string | undefined>()
  const [feedbackRecorded, setFeedbackRecorded] = useState(false)
  const feedbackTriggerRef = useRef<HTMLButtonElement | null>(null)
  const feedbackDetailRef = useRef<HTMLTextAreaElement | null>(null)
  const aliveRef = useRef(true)
  const dialogTitleId = useId()
  const dialogDetailId = useId()
  const feedbackHintId = `${dialogDetailId}-hint`

  const closeDialog = useCallback((): void => {
    if (dialogSaving) return
    setDialogRating(undefined)
    setDialogError(undefined)
    feedbackTriggerRef.current?.focus()
  }, [dialogSaving])

  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  useEffect(() => {
    if (!feedbackRecorded) return
    const timeout = window.setTimeout(() => setFeedbackRecorded(false), 4_000)
    return () => window.clearTimeout(timeout)
  }, [feedbackRecorded])

  useEffect(() => {
    if (dialogRating === undefined) return
    feedbackDetailRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !dialogSaving) closeDialog()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closeDialog, dialogRating, dialogSaving])

  const openDialog = (
    rating: MessageFeedbackRating,
    trigger: HTMLButtonElement,
    editExisting = false,
  ): void => {
    if (props.onFeedbackSubmit === undefined) {
      // Compatibility for callers that have not adopted the rc.2 submit route.
      props.onFeedback?.(rating)
      return
    }
    feedbackTriggerRef.current = trigger
    setDialogRating(rating)
    setDialogDraft(editExisting && props.feedbackRating === rating ? (props.feedbackNote ?? '') : '')
    setDialogCategory(editExisting && props.feedbackRating === rating ? props.feedbackCategory : undefined)
    setDialogError(undefined)
    setDialogSaving(false)
    setFeedbackRecorded(false)
  }

  const chooseFeedback = (rating: MessageFeedbackRating, trigger: HTMLButtonElement): void => {
    if (feedbackPreparing || dialogSaving) return
    const prepare = props.onFeedbackPrepare
    if (prepare === undefined) {
      if (props.feedbackRating === rating && props.onFeedback !== undefined) {
        props.onFeedback(rating)
        return
      }
      openDialog(rating, trigger)
      return
    }

    feedbackTriggerRef.current = trigger
    setFeedbackPreparing(true)
    let result: Promise<MessageFeedbackItem | undefined> | MessageFeedbackItem | undefined
    try {
      result = prepare()
    } catch {
      result = undefined
    }
    void Promise.resolve(result).then(
      (item) => {
        if (!aliveRef.current) return
        setFeedbackPreparing(false)
        if (item?.rating === rating && props.onFeedback !== undefined) {
          props.onFeedback(rating)
          return
        }
        openDialog(rating, trigger)
      },
      () => {
        if (!aliveRef.current) return
        setFeedbackPreparing(false)
        openDialog(rating, trigger)
      },
    )
  }

  const submitDialog = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (dialogRating === undefined || props.onFeedbackSubmit === undefined || dialogSaving) return
    setDialogSaving(true)
    setDialogError(undefined)
    setFeedbackRecorded(false)
    const note = dialogDraft.trim() === '' ? undefined : dialogDraft.trim()
    let result: Promise<void> | void
    try {
      result = props.onFeedbackSubmit(dialogRating, note, dialogCategory)
    } catch {
      if (aliveRef.current) {
        setDialogSaving(false)
        setDialogError(translate('message.feedbackSubmitFailed'))
      }
      return
    }
    void Promise.resolve(result).then(
      () => {
        if (!aliveRef.current) return
        setDialogSaving(false)
        setDialogRating(undefined)
        setDialogError(undefined)
        setFeedbackRecorded(true)
        feedbackTriggerRef.current?.focus()
      },
      () => {
        if (!aliveRef.current) return
        setDialogSaving(false)
        setDialogError(translate('message.feedbackSubmitFailed'))
      },
    )
  }

  const positiveLabel =
    props.feedbackRating === 'positive'
      ? translate('message.feedbackRemove')
      : translate('message.feedbackPositive')
  const negativeLabel =
    props.feedbackRating === 'negative'
      ? translate('message.feedbackRemove')
      : translate('message.feedbackNegative')
  const existingFeedbackRating = props.feedbackRating

  return (
    <>
      <div className="dsh-message-actions" role="toolbar" aria-label={translate('message.actions')}>
        <CopyButton text={props.text} className="dsh-message-actions__button" translate={translate} />
        {hasFeedback ? (
          <>
            <button
              className="dsh-message-actions__button dsh-message-actions__button--feedback-positive"
              type="button"
              aria-label={positiveLabel}
              aria-pressed={props.feedbackRating === 'positive'}
              title={positiveLabel}
              disabled={feedbackUnavailable || feedbackPreparing}
              onClick={(event) => chooseFeedback('positive', event.currentTarget)}
            >
              <Icon name="thumb-up" />
            </button>
            <button
              className="dsh-message-actions__button dsh-message-actions__button--feedback-negative"
              type="button"
              aria-label={negativeLabel}
              aria-pressed={props.feedbackRating === 'negative'}
              title={negativeLabel}
              disabled={feedbackUnavailable || feedbackPreparing}
              onClick={(event) => chooseFeedback('negative', event.currentTarget)}
            >
              <Icon name="thumb-down" />
            </button>
          </>
        ) : null}
        {existingFeedbackRating === undefined || props.onFeedbackSubmit === undefined ? null : (
          <button
            className="dsh-message-actions__button dsh-message-actions__note-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={dialogRating !== undefined}
            aria-label={translate('message.feedbackNote')}
            title={props.feedbackNote === undefined ? translate('message.feedbackNote') : props.feedbackNote}
            disabled={feedbackUnavailable || feedbackPreparing}
            onClick={(event) => openDialog(existingFeedbackRating, event.currentTarget, true)}
          >
            <span aria-hidden="true">{props.feedbackNote === undefined ? '＋' : '✎'}</span>
          </button>
        )}
        {feedbackRecorded ? (
          <span className="dsh-message-actions__feedback-status" role="status">
            {translate('message.feedbackRecorded')}
          </span>
        ) : null}
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
      {dialogRating === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <div
              className="dsh-feedback-dialog__backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeDialog()
              }}
            >
              <form
                className="dsh-session-dialog dsh-feedback-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={dialogTitleId}
                onSubmit={submitDialog}
              >
                <h2 id={dialogTitleId} className="dsh-session-dialog__title">
                  {translate('message.feedbackDialogTitle')}
                </h2>
                <div
                  className="dsh-feedback-dialog__categories"
                  role="group"
                  aria-label={translate('message.feedbackCategories')}
                >
                  {FEEDBACK_CATEGORIES.map((category) => (
                    <button
                      key={category}
                      className="dsh-feedback-dialog__chip"
                      type="button"
                      aria-pressed={dialogCategory === category}
                      disabled={dialogSaving}
                      onClick={() =>
                        setDialogCategory((current) => (current === category ? undefined : category))
                      }
                    >
                      {translate(`message.feedbackCategory.${category}`)}
                    </button>
                  ))}
                </div>
                <label className="dsh-session-dialog__label" htmlFor={dialogDetailId}>
                  {translate('message.feedbackDetails')}
                </label>
                <p id={feedbackHintId} className="dsh-session-dialog__description">
                  {translate('message.feedbackHint')}
                </p>
                <textarea
                  ref={feedbackDetailRef}
                  id={dialogDetailId}
                  className="dsh-feedback-dialog__detail dsh-session-dialog__input"
                  aria-describedby={feedbackHintId}
                  value={dialogDraft}
                  placeholder={translate('message.feedbackHint')}
                  rows={5}
                  maxLength={8_192}
                  readOnly={dialogSaving}
                  onChange={(event) => setDialogDraft(event.target.value)}
                />
                {dialogError === undefined ? null : (
                  <p className="dsh-session-dialog__error" role="alert">
                    {dialogError}
                  </p>
                )}
                <div className="dsh-session-dialog__actions">
                  <button
                    className="dsh-button dsh-button--secondary"
                    type="button"
                    disabled={dialogSaving}
                    onClick={closeDialog}
                  >
                    {translate('message.cancelFeedbackNote')}
                  </button>
                  <button className="dsh-button dsh-button--primary" type="submit" disabled={dialogSaving}>
                    {dialogSaving
                      ? translate('message.feedbackSubmitting')
                      : translate('message.feedbackSubmit')}
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )}
    </>
  )
}
