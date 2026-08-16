import type { ReactElement } from 'react'
import type { ExtensionSettings } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface SettingsDrawerProps {
  readonly settings: ExtensionSettings
  readonly connectedDshVersion: string | undefined
}

export function SettingsDrawer(props: SettingsDrawerProps): ReactElement {
  return unimplemented<ReactElement>('DSH settings drawer and VS Code settings bridge', [
    'organize Connection, Runtime, Agent, Model, Provider, Security, and Diagnostics sections',
    'use VS Code configuration commands for extension settings and DSH RPCs for backend settings',
    'explain which changes affect new sessions, current session, or require reconnect',
    'validate ports and modes before writing and retain unsaved values on errors',
    `mode ${props.settings.connection.mode}; DSH version ${props.connectedDshVersion ?? 'not connected'}`,
  ])
}
