import { useState, type ReactElement } from 'react'
import type { UserQuestion } from '@dsh-vscode/domain'

export interface UserQuestionCardProps {
  readonly question: UserQuestion
  readonly disabled: boolean
  readonly onRespond: (response: string | readonly string[]) => void
}

export function UserQuestionCard(props: UserQuestionCardProps): ReactElement {
  const [response, setResponse] = useState<string | readonly string[]>('')
  const choices = props.question.choices ?? []
  return (
    <section className="dsh-interaction" role="group" aria-labelledby={`question-${props.question.id}`}>
      <header className="dsh-interaction__header">
        <span className="dsh-interaction__icon" aria-hidden="true">
          ?
        </span>
        <div>
          <span className="dsh-app__eyebrow">INPUT NEEDED</span>
          <h2 id={`question-${props.question.id}`}>{props.question.prompt}</h2>
        </div>
      </header>
      {choices.length > 0 ? (
        <div className="dsh-question__choices">
          {choices.map((choice) => (
            <label className="dsh-question__choice" key={choice.id}>
              <input
                type={props.question.multiSelect === true ? 'checkbox' : 'radio'}
                name={props.question.id}
                disabled={props.disabled}
                checked={
                  props.question.multiSelect === true
                    ? Array.isArray(response) && response.includes(choice.id)
                    : response === choice.id
                }
                onChange={() => {
                  if (props.question.multiSelect !== true) {
                    setResponse(choice.id)
                    return
                  }
                  const selected = isStringArray(response) ? [...response] : []
                  const index = selected.indexOf(choice.id)
                  if (index < 0) selected.push(choice.id)
                  else selected.splice(index, 1)
                  setResponse(selected)
                }}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      ) : null}
      {props.question.allowFreeText ? (
        <textarea
          className="dsh-question__textarea"
          disabled={props.disabled}
          value={
            typeof response === 'string' && choices.every((choice) => choice.id !== response) ? response : ''
          }
          onChange={(event) => setResponse(event.target.value)}
          aria-label="Answer"
        />
      ) : null}
      <button
        className="dsh-button dsh-button--primary"
        type="button"
        disabled={
          props.disabled || (typeof response === 'string' ? response.length === 0 : response.length === 0)
        }
        onClick={() => props.onRespond(response)}
      >
        Submit
      </button>
    </section>
  )
}

function isStringArray(value: string | readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
}
