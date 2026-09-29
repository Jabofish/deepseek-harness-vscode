import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import type { QuestionAnswer, QuestionChoice, UserQuestion, UserQuestionItem } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { ContentFlow } from '../../components/common/ContentFlow.js'

export interface UserQuestionCardProps {
  readonly question: UserQuestion
  readonly disabled: boolean
  readonly onRespond: (
    response: string | readonly string[] | readonly QuestionAnswer[],
  ) => void | Promise<void>
  readonly onCancel: () => void
  readonly onAttachWait?: () => Promise<number | undefined>
  readonly onReleaseWait?: () => Promise<void>
}

interface ItemDraft {
  readonly selected: readonly string[]
  readonly custom: string
  readonly skipped: boolean
}

interface TimedWaitState {
  readonly key: string
  readonly phase: 'ready' | 'failed'
  readonly remainingMs?: number
}

/**
 * Official ask() semantics: one request may carry many questions and is
 * answered by ONE batch client-response (never split per question). Each
 * item renders its header/detail/options (with per-option descriptions) and
 * a free-text slot; a plan-review intent promotes the approving option.
 */
// A pending card docks in the composer slot for as long as the conversation
// streams behind it; memo keeps those frames from re-rendering the card.
export const UserQuestionCard = memo(function UserQuestionCard(props: UserQuestionCardProps): ReactElement {
  const { t } = useI18n()
  const items = questionItems(props.question)
  const planReview = isPlanReview(items)
  const timedForeground = props.question.state === 'open' && props.question.timed === true
  const [drafts, setDrafts] = useState<readonly ItemDraft[]>(() =>
    items.map(() => ({ selected: [], custom: '', skipped: false })),
  )
  const [waitState, setWaitState] = useState<TimedWaitState | undefined>(undefined)
  const [submitted, setSubmitted] = useState(false)
  const [waitAttempt, setWaitAttempt] = useState(0)
  const lastServerQueued = useRef(props.question.replyQueued === true)
  const waitHandlers = useRef({ attach: props.onAttachWait, release: props.onReleaseWait })
  useEffect(() => {
    waitHandlers.current = { attach: props.onAttachWait, release: props.onReleaseWait }
  }, [props.onAttachWait, props.onReleaseWait])
  const waitKey = `${props.question.sessionId}\u0000${props.question.callId ?? ''}\u0000${waitAttempt}`
  const currentWaitState = waitState?.key === waitKey ? waitState : undefined
  const waitReady = !timedForeground || currentWaitState?.phase === 'ready'
  const waitFailed =
    timedForeground && (props.onAttachWait === undefined || currentWaitState?.phase === 'failed')
  const remainingMs = currentWaitState?.phase === 'ready' ? currentWaitState.remainingMs : undefined
  useEffect(() => {
    if (!timedForeground) return
    const attach = waitHandlers.current.attach
    if (attach === undefined) return
    let active = true
    let timer: number | undefined
    let waitReleased = false
    void attach()
      .then((duration) => {
        if (!active) return
        if (duration === undefined) {
          setWaitState({ key: waitKey, phase: 'ready', remainingMs: 0 })
          waitReleased = true
          void waitHandlers.current.release?.()
          return
        }
        if (duration <= 0) {
          setWaitState({ key: waitKey, phase: 'ready', remainingMs: 0 })
          waitReleased = true
          void waitHandlers.current.release?.()
          return
        }
        const deadline = Date.now() + duration
        const update = (): void => {
          const remaining = Math.max(0, deadline - Date.now())
          setWaitState({ key: waitKey, phase: 'ready', remainingMs: remaining })
          if (remaining === 0 && !waitReleased) {
            waitReleased = true
            if (timer !== undefined) window.clearInterval(timer)
            void waitHandlers.current.release?.()
          }
        }
        update()
        timer = window.setInterval(update, 250)
      })
      .catch(() => {
        if (active) {
          setWaitState({ key: waitKey, phase: 'failed' })
        }
      })
    return () => {
      active = false
      if (timer !== undefined) window.clearInterval(timer)
      void waitHandlers.current.release?.()
    }
  }, [props.question.callId, props.question.sessionId, timedForeground, waitAttempt, waitKey])
  useEffect(() => {
    const serverQueued = props.question.replyQueued === true
    if (lastServerQueued.current && !serverQueued) setSubmitted(false)
    lastServerQueued.current = serverQueued
  }, [props.question.replyQueued])
  const complete =
    drafts.length === items.length && drafts.every((draft) => hasAnswer(draft) || draft.skipped)
  const replyQueued = props.question.replyQueued === true || submitted
  const timedUnavailable = timedForeground && (!waitReady || waitFailed || remainingMs === 0)
  const submitDisabled = props.disabled || replyQueued || timedUnavailable || (!complete && !planReview)
  const submit = async (response: string | readonly string[] | readonly QuestionAnswer[]): Promise<void> => {
    try {
      await props.onRespond(response)
      if (props.question.state === 'continued') setSubmitted(true)
    } catch {
      // The owning hook reports the Host error; keep the draft editable here.
    }
  }
  return (
    <section
      className={`dsh-interaction${planReview ? ' dsh-interaction--plan-review' : ''}`}
      role="group"
      aria-labelledby={`question-${props.question.id}`}
    >
      <header className="dsh-interaction__header">
        <span className="dsh-interaction__icon" aria-hidden="true">
          ?
        </span>
        <div>
          <span className="dsh-app__eyebrow">
            {t(planReview ? 'question.planReview' : 'question.inputNeeded')}
          </span>
          <h2 id={`question-${props.question.id}`}>{items[0]?.prompt ?? ''}</h2>
        </div>
      </header>
      {timedForeground ? (
        <div className="dsh-question__wait" role="status">
          <span>
            {waitFailed
              ? t('question.waitUnavailable')
              : !waitReady
                ? t('question.waitConnecting')
                : remainingMs === 0
                  ? t('question.waitExpired')
                  : t('question.timeRemaining', { seconds: Math.ceil((remainingMs ?? 0) / 1_000) })}
          </span>
          {waitFailed ? (
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              disabled={props.disabled}
              onClick={() => setWaitAttempt((attempt) => attempt + 1)}
            >
              {t('question.waitRetry')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="dsh-interaction__body">
        {items.map((item, index) => (
          <div className="dsh-question__item" key={item.id}>
            {items.length > 1 || item.header === undefined ? null : (
              <ContentFlow as="p" className="dsh-question__header">
                {item.header}
              </ContentFlow>
            )}
            {items.length > 1 ? (
              <h3 className="dsh-question__item-title">
                {item.header === undefined ? item.prompt : item.header}
              </h3>
            ) : null}
            {items.length > 1 ? (
              <ContentFlow as="p" className="dsh-question__prompt">
                {item.prompt}
              </ContentFlow>
            ) : null}
            {item.detail === undefined ? null : (
              <ContentFlow as="p" className="dsh-question__detail">
                {item.detail}
              </ContentFlow>
            )}
            {item.choices === undefined || item.choices.length === 0 ? null : (
              <div className="dsh-question__choices" role="group" aria-label={item.prompt}>
                {item.choices.map((choice) => {
                  const checked = drafts[index]?.selected.includes(choice.id) === true
                  return (
                    <label
                      className={`dsh-question__choice${
                        planReview && isApproveChoice(item, choice) ? ' dsh-question__choice--approve' : ''
                      }`}
                      key={choice.id}
                    >
                      <input
                        type={item.multiSelect === true ? 'checkbox' : 'radio'}
                        name={`${props.question.id}:${item.id}`}
                        disabled={props.disabled}
                        checked={checked}
                        onChange={() => {
                          setDrafts((current) =>
                            current.map((draft, position) =>
                              position === index
                                ? {
                                    selected:
                                      item.multiSelect === true
                                        ? toggle(draft.selected, choice.id)
                                        : [choice.id],
                                    custom: item.multiSelect === true ? draft.custom : '',
                                    skipped: false,
                                  }
                                : draft,
                            ),
                          )
                        }}
                      />
                      <span>
                        <ContentFlow as="span" className="dsh-question__choice-label">
                          {planReview && isApproveChoice(item, choice) && item.multiSelect !== true
                            ? t('question.approveHint', { label: choice.label })
                            : choice.label}
                        </ContentFlow>
                        {choice.description === undefined ? null : (
                          <ContentFlow as="span" className="dsh-question__choice-description">
                            {choice.description}
                          </ContentFlow>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {!planReview ? (
              <QuestionAnswerField
                value={drafts[index]?.custom ?? ''}
                disabled={props.disabled}
                ariaLabel={t('question.answer', { prompt: item.prompt })}
                placeholder={t('question.custom')}
                onChange={(value) => {
                  setDrafts((current) =>
                    current.map((draft, position) =>
                      position === index
                        ? {
                            selected: item.multiSelect === true ? draft.selected : [],
                            custom: value,
                            skipped: false,
                          }
                        : draft,
                    ),
                  )
                }}
              />
            ) : null}
            {!planReview ? (
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                disabled={props.disabled}
                onClick={() =>
                  setDrafts((current) =>
                    current.map((draft, position) =>
                      position === index ? { selected: [], custom: '', skipped: true } : draft,
                    ),
                  )
                }
              >
                {t(drafts[index]?.skipped === true ? 'question.skipped' : 'question.skip')}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {planReview ? (
        <PlanDecisionRow
          item={items[0]!}
          disabled={submitDisabled}
          {...(props.question.state === 'continued' ? {} : { onChat: props.onCancel })}
          onRespond={(choice) => {
            void submit([{ id: items[0]!.id, response: [choice.id] }])
          }}
        />
      ) : (
        <div className="dsh-interaction__actions">
          {props.question.state !== 'continued' ? (
            <button
              className="dsh-button dsh-button--secondary"
              type="button"
              disabled={props.disabled}
              onClick={props.onCancel}
            >
              {t('question.cancel')}
            </button>
          ) : null}
          {replyQueued ? (
            <span className="dsh-question__wait" role="status">
              {t('question.replyQueued')}
            </span>
          ) : (
            <button
              className="dsh-button dsh-button--primary"
              type="button"
              disabled={submitDisabled}
              onClick={() => {
                void submit(encodeAnswers(items, drafts))
              }}
            >
              {t('question.submit')}
            </button>
          )}
        </div>
      )}
    </section>
  )
})

interface QuestionAnswerFieldProps {
  readonly value: string
  readonly disabled: boolean
  readonly ariaLabel: string
  readonly placeholder: string
  readonly onChange: (value: string) => void
}

/**
 * Mirror-backed answer field matching the upstream six-line behavior. The
 * hidden mirror determines the height; the textarea becomes the only
 * scrollport once the cap is reached, so a long answer cannot push the
 * question actions out of the takeover card.
 */
function QuestionAnswerField(props: QuestionAnswerFieldProps): ReactElement {
  return (
    <div className="dsh-question__field">
      <div className="dsh-question__field-mirror" aria-hidden="true">
        {`${props.value}\n`}
      </div>
      <textarea
        className="dsh-question__textarea"
        disabled={props.disabled}
        value={props.value}
        rows={1}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  )
}

function encodeAnswers(
  items: readonly UserQuestionItem[],
  drafts: readonly ItemDraft[],
): readonly QuestionAnswer[] {
  return items.map((item, index) => {
    const draft = drafts[index] ?? { selected: [], custom: '', skipped: false }
    return {
      id: item.id,
      response:
        draft.skipped || (item.multiSelect !== true && draft.custom.trim() !== '') ? [] : draft.selected,
      ...(draft.skipped || draft.custom.trim() === '' ? {} : { custom: draft.custom.trim() }),
    }
  })
}

function PlanDecisionRow(props: {
  readonly item: UserQuestionItem
  readonly disabled: boolean
  readonly onChat?: () => void
  readonly onRespond: (choice: QuestionChoice) => void
}): ReactElement {
  const { t } = useI18n()
  const approve = props.item.choices?.find((choice) => isApproveChoice(props.item, choice))
  const refuse = props.item.choices?.find((choice) => !isApproveChoice(props.item, choice))
  return (
    <div
      className="dsh-question__decision-row dsh-interaction__actions"
      role="group"
      aria-label={t('question.planDecision')}
    >
      {props.onChat === undefined ? null : (
        <button
          className="dsh-button dsh-button--secondary"
          type="button"
          disabled={props.disabled}
          onClick={props.onChat}
        >
          {t('question.discuss')}
        </button>
      )}
      <button
        className="dsh-button dsh-button--secondary"
        type="button"
        disabled={props.disabled || refuse === undefined}
        onClick={() => {
          if (refuse !== undefined) props.onRespond(refuse)
        }}
      >
        {t('question.refuse')}
      </button>
      <button
        className="dsh-button dsh-button--primary"
        type="button"
        disabled={props.disabled || approve === undefined}
        onClick={() => {
          if (approve !== undefined) props.onRespond(approve)
        }}
      >
        {t('question.approve')}
      </button>
    </div>
  )
}

function questionItems(question: UserQuestion): readonly UserQuestionItem[] {
  if (question.items !== undefined && question.items.length > 0) return question.items
  return [
    {
      id: question.id,
      prompt: question.prompt,
      ...(question.detail === undefined ? {} : { detail: question.detail }),
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.choices === undefined ? {} : { choices: question.choices }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      allowFreeText: question.allowFreeText,
      ...(question.intent === undefined ? {} : { intent: question.intent }),
    },
  ]
}

function hasAnswer(draft: ItemDraft): boolean {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function isPlanReview(items: readonly UserQuestionItem[]): boolean {
  if (items.length !== 1) return false
  const item = items[0]
  if (
    item === undefined ||
    item.detail === undefined ||
    item.intent?.kind !== 'plan-review' ||
    item.multiSelect === true ||
    (item.choices?.length ?? 0) > 2
  )
    return false
  return item.choices?.some((choice) => choice.label === item.intent?.approve) === true
}

function isApproveChoice(item: UserQuestionItem, choice: QuestionChoice): boolean {
  return item.intent?.kind === 'plan-review' && item.intent.approve === choice.label
}

function toggle(selected: readonly string[], id: string): readonly string[] {
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
}
