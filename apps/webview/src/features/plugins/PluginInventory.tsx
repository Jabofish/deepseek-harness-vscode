import type { ReactElement } from 'react'
import type { PluginDescriptor } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface PluginInventoryProps {
  readonly plugins: readonly PluginDescriptor[]
  readonly onConfigure: (pluginId: string, enabled: boolean) => void
}

export function PluginInventory(props: PluginInventoryProps): ReactElement {
  return unimplemented<ReactElement>('DSH plugin inventory and explicit configuration', [
    'show installed, enabled, capability, and restart-required metadata',
    'make any enable or disable operation explicit and confirm high-permission plugins',
    'never force-restart an external backend',
    'render unsupported operations as informational rather than fake controls',
    `plugins ${props.plugins.length}; callback ${typeof props.onConfigure}`,
  ])
}
