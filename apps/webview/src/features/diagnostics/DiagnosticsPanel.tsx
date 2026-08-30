import type { ReactElement } from 'react'
import { ContentFlow } from '../../components/common/ContentFlow.js'

export interface DiagnosticsSnapshot {
  readonly extensionVersion: string
  readonly dshVersion?: string
  readonly state: string
  readonly endpointKind?: 'configured' | 'external' | 'managed'
  readonly recentEvents: readonly string[]
}

export function DiagnosticsPanel({ snapshot }: { readonly snapshot: DiagnosticsSnapshot }): ReactElement {
  const report = [
    `Extension: ${snapshot.extensionVersion}`,
    `DSH: ${snapshot.dshVersion ?? 'not connected'}`,
    `State: ${snapshot.state}`,
    `Ownership: ${snapshot.endpointKind ?? 'unknown'}`,
    ...snapshot.recentEvents.slice(-20).map((event) => `Event: ${event.slice(0, 256)}`),
  ].join('\n')
  return (
    <section className="dsh-diagnostics" aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">Diagnostics</h2>
      <dl>
        <dt>Extension</dt>
        <dd>{snapshot.extensionVersion}</dd>
        <dt>DSH</dt>
        <dd>{snapshot.dshVersion ?? 'not connected'}</dd>
        <dt>State</dt>
        <dd>{snapshot.state}</dd>
        <dt>Ownership</dt>
        <dd>{snapshot.endpointKind ?? 'unknown'}</dd>
      </dl>
      <ContentFlow as="details">
        <summary>Preview redacted report</summary>
        <pre>{report}</pre>
      </ContentFlow>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(report)
        }}
      >
        Copy report
      </button>
    </section>
  )
}
