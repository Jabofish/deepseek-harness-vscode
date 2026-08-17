import type { ReactElement } from 'react'
import type { ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'
import { CompactPicker, type CompactPickerOption } from '../composer/CompactPicker.js'
import { useI18n } from '../../i18n.js'

export interface ModelPickerProps {
  readonly models: readonly ModelDescriptor[]
  readonly value: ModelSelection
  readonly disabled?: boolean
  readonly displayLabel?: boolean
  readonly openRequest?: number
  readonly onChange: (value: ModelSelection) => void
}

export function ModelPicker(props: ModelPickerProps): ReactElement {
  const { t } = useI18n()
  const selected = props.models.find(
    (model) => model.providerId === props.value.providerId && model.id === props.value.modelId,
  )
  const options = props.models.flatMap((model) => {
    const reasoningLevels = model.supportsReasoning ? (model.reasoningLevels ?? []) : []
    if (reasoningLevels.length === 0) {
      return [
        {
          model: { providerId: model.providerId, modelId: model.id },
          label: model.label,
        },
      ]
    }
    return reasoningLevels.map((reasoningLevel) => ({
      model: { providerId: model.providerId, modelId: model.id, reasoningLevel },
      label: `${model.label} · ${reasoningLevel}`,
    }))
  })
  const selectedIndex = options.findIndex((option) => sameSelection(option.model, props.value, selected))
  const currentValue = selectedIndex < 0 ? 'unavailable' : `model:${selectedIndex}`
  const pickerOptions: CompactPickerOption[] = [
    ...(selectedIndex < 0
      ? [
          {
            value: 'unavailable',
            label:
              selected === undefined ? t('model.default') : t('model.unavailable', { label: selected.label }),
            disabled: true,
          },
        ]
      : []),
    ...options.map((option, index) => ({
      value: `model:${index}`,
      label: option.label,
    })),
  ]
  const currentLabel =
    selectedIndex < 0
      ? selected === undefined
        ? t('model.default')
        : t('model.unavailable', { label: selected.label })
      : (options[selectedIndex]?.label ?? t('model.default'))
  return (
    <CompactPicker
      className="dsh-model-picker"
      icon="model"
      {...(props.displayLabel === undefined ? {} : { displayLabel: props.displayLabel })}
      {...(props.openRequest === undefined ? {} : { openRequest: props.openRequest })}
      label={currentLabel}
      ariaLabel={t('model.aria')}
      title={t('model.select')}
      value={currentValue}
      options={pickerOptions}
      disabled={props.disabled ?? false}
      onChange={(value) => {
        if (!value.startsWith('model:')) return
        const index = Number(value.slice('model:'.length))
        const option = Number.isInteger(index) ? options[index] : undefined
        if (option !== undefined) props.onChange(option.model)
      }}
    />
  )
}

function sameSelection(
  option: ModelSelection,
  value: ModelSelection,
  selected: ModelDescriptor | undefined,
): boolean {
  if (option.providerId !== value.providerId || option.modelId !== value.modelId) return false
  if (option.reasoningLevel === value.reasoningLevel) return true
  return value.reasoningLevel === undefined && option.reasoningLevel === selected?.reasoningLevels?.[0]
}
