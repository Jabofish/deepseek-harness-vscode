import { useState, type ReactElement } from 'react'
import type { QuestionAnswer, QuestionChoice, UserQuestion, UserQuestionItem } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'

export interface UserQuestionCardProps {
  readonly question: UserQuestion
  readonly disabled: boolean
  readonly onRespond: (response: string | readonly string[] | readonly QuestionAnswer[]) => void
  readonly onCancel: () => void
}

interface ItemDraft {
  readonly selected: readonly string[]
  readonly custom: string
  readonly skipped: boolean
}

/**
 * Official ask() semantics: one request may carry many questions and is
 * answered by ONE batch client-response (never split per question). Each
 * item renders its header/detail/options (with per-option descriptions) and
 * a free-text slot; a plan-review intent promotes the approving option.
 */
export function UserQuestionCard(props: UserQuestionCardProps): ReactElement {
  const { t } = useI18n()
  const items = questionItems(props.question)
  const planReview = isPlanReview(items)
  const [drafts, setDrafts] = useState<readonly ItemDraft[]>(() =>
    items.map(() => ({ selected: [], custom: '', skipped: false })),
  )
  const complete =
    drafts.length === items.length && drafts.every((draft) => hasAnswer(draft) || draft.skipped)
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
      {items.map((item, index) => (
        <div className="dsh-question__item" key={item.id}>
          {items.length > 1 || item.header === undefined ? null : (
            <p className="dsh-question__header">{item.header}</p>
          )}
          {items.length > 1 ? (
            <h3 className="dsh-question__item-title">
              {item.header === undefined ? item.prompt : item.header}
            </h3>
          ) : null}
          {items.length > 1 ? <p className="dsh-question__prompt">{item.prompt}</p> : null}
          {item.detail === undefined ? null : <p className="dsh-question__detail">{item.detail}</p>}
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
                      <span className="dsh-question__choice-label">
                        {planReview && isApproveChoice(item, choice) && item.multiSelect !== true
                          ? t('question.approveHint', { label: choice.label })
                          : choice.label}
                      </span>
                      {choice.description === undefined ? null : (
                        <span className="dsh-question__choice-description">{choice.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
          {!planReview ? (
            <textarea
              className="dsh-question__textarea"
              disabled={props.disabled}
              value={drafts[index]?.custom ?? ''}
              onChange={(event) => {
                const value = event.target.value
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
              aria-label={t('question.answer', { prompt: item.prompt })}
              placeholder={t('question.custom')}
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
      <button
        className="dsh-button dsh-button--primary"
        type="button"
        disabled={props.disabled || !complete}
        onClick={() => {
          // Always submit the batch encoding (a one-element batch is fine):
          // selections and free text stay separate slots this way.
          props.onRespond(
            items.map((item, index) => {
              const draft = drafts[index] ?? { selected: [], custom: '', skipped: false }
              return {
                id: item.id,
                response:
                  draft.skipped || (item.multiSelect !== true && draft.custom.trim() !== '')
                    ? []
                    : draft.selected,
                ...(draft.skipped || draft.custom.trim() === '' ? {} : { custom: draft.custom.trim() }),
              }
            }),
          )
        }}
      >
        {t('question.submit')}
      </button>
      <button
        className="dsh-button dsh-button--secondary"
        type="button"
        disabled={props.disabled}
        onClick={props.onCancel}
      >
        {t(planReview ? 'question.discuss' : 'question.cancel')}
      </button>
    </section>
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
