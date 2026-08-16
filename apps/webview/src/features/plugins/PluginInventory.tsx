import type { ReactElement } from 'react'
import type { PluginDescriptor } from '@dsh-vscode/domain'

export interface PluginInventoryProps {
  readonly plugins: readonly PluginDescriptor[]
  readonly onConfigure: (pluginId: string, enabled: boolean) => void
}

export function PluginInventory(props: PluginInventoryProps): ReactElement {
  return (
    <section className="dsh-plugins" aria-labelledby="plugins-title">
      <h2 id="plugins-title">Plugins</h2>
      {props.plugins.length === 0 ? (
        <p>Plugin inventory is unavailable for this DSH version.</p>
      ) : (
        <ul>
          {props.plugins.map((plugin) => (
            <li key={plugin.id}>
              <strong>{plugin.name}</strong>
              <span>
                {plugin.installed ? 'Installed' : 'Not installed'} · {plugin.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <small>
                {plugin.capabilities.join(', ') || 'No capabilities reported'}
                {plugin.requiresRestart ? ' · restart required' : ''}
              </small>
              {plugin.installed ? (
                <button type="button" onClick={() => props.onConfigure(plugin.id, !plugin.enabled)}>
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
