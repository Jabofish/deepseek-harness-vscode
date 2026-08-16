import type { ReactElement } from 'react'
import type { ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ModelPickerProps {
  readonly models: readonly ModelDescriptor[]
  readonly value: ModelSelection
  readonly onChange: (value: ModelSelection) => void
}

export function ModelPicker(props: ModelPickerProps): ReactElement {
  return unimplemented<ReactElement>('dynamic provider/model/reasoning picker', [
    'group and filter models from the connected DSH backend, never a hard-coded list',
    'show reasoning levels only when supported by the selected model',
    'retain an unavailable current model visibly until the user chooses a replacement',
    'apply per-session changes with loading, rollback, and error state',
    `models ${props.models.length}; current ${props.value.providerId}/${props.value.modelId}; callback ${typeof props.onChange}`,
  ])
}
