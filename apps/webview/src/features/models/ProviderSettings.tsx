import type { ReactElement } from 'react'
import type { ModelProvider } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ProviderSettingsProps {
  readonly providers: readonly ModelProvider[]
  readonly onConfigureSecret: (providerId: string, field: string) => void
}

export function ProviderSettings(props: ProviderSettingsProps): ReactElement {
  return unimplemented<ReactElement>('model provider configuration UI', [
    'render all dynamic non-secret provider fields with validation',
    'show secret fields as configured or missing without receiving their values',
    'request Extension Host password input for secret updates',
    'support custom provider base URL and model configuration only as advertised by DSH',
    `providers ${props.providers.length}; secret callback ${typeof props.onConfigureSecret}`,
  ])
}
