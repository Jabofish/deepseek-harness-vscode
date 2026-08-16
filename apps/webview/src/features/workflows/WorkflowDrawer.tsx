import type { ReactElement } from 'react'
import type { WorkflowSummary } from '@dsh-vscode/domain'

export interface WorkflowDrawerProps {
  readonly workflows: readonly WorkflowSummary[]
  readonly onStart: (workflowId: string) => void
  readonly onCancel: (workflowId: string) => void
}

export function WorkflowDrawer(props: WorkflowDrawerProps): ReactElement {
  return (
    <section className="dsh-workflows" aria-labelledby="workflows-title">
      <h2 id="workflows-title">Workflows</h2>
      {props.workflows.length === 0 ? (
        <p>Workflows are not exposed by this DSH version.</p>
      ) : (
        <ul>
          {props.workflows.map((workflow) => (
            <li key={workflow.id}>
              <strong>{workflow.name}</strong>
              <span>
                {workflow.kind} · {workflow.status}
              </span>
              <ol>
                {workflow.stages.map((stage) => (
                  <li key={stage.id}>
                    {stage.label} · {stage.status}
                  </li>
                ))}
              </ol>
              {workflow.status === 'pending' ? (
                <button type="button" onClick={() => props.onStart(workflow.id)}>
                  Start
                </button>
              ) : workflow.status === 'running' ? (
                <button type="button" onClick={() => props.onCancel(workflow.id)}>
                  Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
