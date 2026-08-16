import type { ReactElement } from 'react'
import type { ExtensionSettings } from '@dsh-vscode/domain'

export interface SettingsDrawerProps {
  readonly settings: ExtensionSettings
  readonly connectedDshVersion: string | undefined
}

export function SettingsDrawer(props: SettingsDrawerProps): ReactElement {
  return (
    <section className="dsh-settings" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>
      <dl>
        <dt>Connection mode</dt>
        <dd>{props.settings.connection.mode}</dd>
        <dt>Managed port</dt>
        <dd>
          {props.settings.connection.managedPort === 0 ? 'Automatic' : props.settings.connection.managedPort}
        </dd>
        <dt>Runtime</dt>
        <dd>{props.settings.runtime.executablePath ?? 'PATH / npm global'}</dd>
        <dt>DSH version</dt>
        <dd>{props.connectedDshVersion ?? 'not connected'}</dd>
        <dt>Permission preset</dt>
        <dd>{props.settings.security.defaultPermissionPreset}</dd>
      </dl>
      <p>
        Connection and runtime changes are applied by the Extension Host and never sent to the Webview as
        secrets.
      </p>
    </section>
  )
}
