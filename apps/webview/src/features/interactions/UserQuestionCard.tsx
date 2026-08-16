import type { ReactElement } from 'react'
import type { UserQuestion } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface UserQuestionCardProps {
  readonly question: UserQuestion
  readonly disabled: boolean
  readonly onRespond: (response: string | readonly string[]) => void
}

export function UserQuestionCard(props: UserQuestionCardProps): ReactElement {
  return unimplemented<ReactElement>('DSH user question interaction card', [
    'support single choice, multiple choice, and free text based on the request contract',
    'validate required selection and preserve unsent input across transient rerenders',
    'submit once and show stale-question recovery',
    `question ${props.question.id}; disabled ${String(props.disabled)}; callback ${typeof props.onRespond}`,
  ])
}
