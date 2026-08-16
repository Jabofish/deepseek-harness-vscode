import type { ReactElement } from 'react'
import type { BackendState } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'

export function RuntimeStatus({ state }: { readonly state: BackendState }): ReactElement {
  const label =
    state.kind === 'connected'
      ? 'Connected'
      : state.kind === 'runtime-missing'
        ? 'Runtime missing'
        : state.kind === 'failed' || state.kind === 'port-conflict'
          ? 'Connection failed'
          : `${state.kind.slice(0, 1).toUpperCase()}${state.kind.slice(1)}`
  return (
    <div
      className={`dsh-runtime-status dsh-runtime-status--${state.kind}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      title={state.kind === 'failed' || state.kind === 'port-conflict' ? state.message : label}
    >
      <Icon name="status" className="dsh-runtime-status__dot" />
      <span className="dsh-sr-only">{label}</span>
    </div>
  )
}
