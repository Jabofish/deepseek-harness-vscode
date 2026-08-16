import type { ReactElement } from 'react'
import type { SubagentView } from '@dsh-vscode/domain'

export interface SubagentDrawerProps {
  readonly subagents: readonly SubagentView[]
  readonly onSend: (sessionId: string, message: string) => void
}

export function SubagentDrawer(props: SubagentDrawerProps): ReactElement {
  return (
    <section className="dsh-subagents" aria-labelledby="subagents-title">
      <h2 id="subagents-title">Subagents</h2>
      {props.subagents.length === 0 ? (
        <p>No subagents reported by DSH.</p>
      ) : (
        <ul>
          {props.subagents.map((subagent) => (
            <li key={subagent.id}>
              <strong>{subagent.label}</strong>
              <span>{subagent.status}</span>
              <button type="button" onClick={() => props.onSend(subagent.id, 'Continue')}>
                Send “Continue”
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
