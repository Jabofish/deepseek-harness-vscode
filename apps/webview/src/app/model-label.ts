import type { AgentConfiguration, ModelDescriptor, SessionSummary } from '@dsh-vscode/domain'
import type { Translate } from '../i18n.js'

export function resolveAssistantModelLabel(
  session: SessionSummary | undefined,
  configuration: AgentConfiguration | undefined,
  models: readonly ModelDescriptor[],
  t: Translate,
): string {
  const selected =
    configuration === undefined
      ? undefined
      : models.find(
          (model) =>
            model.providerId === configuration.model.providerId && model.id === configuration.model.modelId,
        )
  return (
    selected?.label.trim() ||
    session?.modelLabel?.trim() ||
    configuration?.model.modelId.trim() ||
    t('timeline.assistant')
  )
}
