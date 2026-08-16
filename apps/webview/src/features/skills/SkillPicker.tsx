import type { ReactElement } from 'react'
import type { SkillDescriptor } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface SkillPickerProps {
  readonly skills: readonly SkillDescriptor[]
  readonly onExecute: (skillId: string) => void
  readonly onRefresh: () => void
}

export function SkillPicker(props: SkillPickerProps): ReactElement {
  return unimplemented<ReactElement>('DSH skill discovery and execution picker', [
    'search and group project, user, and plugin skills',
    'show source and enabled state while leaving precedence resolution to DSH',
    'execute only after explicit selection and route input through the current session',
    `skills ${props.skills.length}; callbacks ${typeof props.onExecute}/${typeof props.onRefresh}`,
  ])
}
