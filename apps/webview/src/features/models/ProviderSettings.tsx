import type { ReactElement } from 'react'
import type { ModelProvider } from '@dsh-vscode/domain'
import { ContentFlow } from '../../components/common/ContentFlow.js'

export interface ProviderSettingsProps {
  readonly providers: readonly ModelProvider[]
  readonly onConfigureSecret: (providerId: string, field: string) => void
}

export function ProviderSettings(props: ProviderSettingsProps): ReactElement {
  return (
    <section className="dsh-providers" aria-labelledby="providers-title">
      <h2 id="providers-title">Providers</h2>
      {props.providers.length === 0 ? (
        <p>No providers reported by DSH.</p>
      ) : (
        <ul>
          {props.providers.map((provider) => (
            <li key={provider.id}>
              <ContentFlow as="strong">{provider.name}</ContentFlow>
              <ContentFlow as="small">{provider.kind}</ContentFlow>
              <ul>
                {provider.fields.map((field) => (
                  <li key={field.key}>
                    {field.label}:{' '}
                    {field.secret ? (
                      <>
                        <span>{field.value === undefined ? 'Missing' : 'Configured'}</span>
                        <button type="button" onClick={() => props.onConfigureSecret(provider.id, field.key)}>
                          Configure
                        </button>
                      </>
                    ) : (
                      <span>{field.value ?? 'Not set'}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
