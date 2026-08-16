import type { ReactElement } from 'react'
import type { JobView } from '@dsh-vscode/domain'

export interface JobsDrawerProps {
  readonly jobs: readonly JobView[]
  readonly onCancel: (jobId: string) => void
}

export function JobsDrawer(props: JobsDrawerProps): ReactElement {
  return (
    <section className="dsh-jobs" aria-labelledby="jobs-title">
      <h2 id="jobs-title">Jobs</h2>
      {props.jobs.length === 0 ? (
        <p>No background jobs reported by DSH.</p>
      ) : (
        <ul>
          {props.jobs.map((job) => (
            <li key={job.id}>
              <strong>{job.label}</strong>
              <span>
                {' '}
                {job.status}
                {job.progress === undefined ? '' : ` · ${Math.round(job.progress * 100)}%`}
              </span>
              {job.status === 'running' ? (
                <button type="button" onClick={() => props.onCancel(job.id)}>
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
