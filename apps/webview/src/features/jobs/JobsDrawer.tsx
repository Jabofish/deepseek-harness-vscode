import type { ReactElement } from 'react'
import type { JobView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface JobsDrawerProps {
  readonly jobs: readonly JobView[]
  readonly onCancel: (jobId: string) => void
}

export function JobsDrawer(props: JobsDrawerProps): ReactElement {
  return unimplemented<ReactElement>('background jobs drawer', [
    'list running and recent jobs with progress, timing, status, and bounded output',
    'cancel only when DSH reports cancellation support',
    'distinguish cancelling a job from stopping a session or backend',
    `jobs ${props.jobs.length}; callback ${typeof props.onCancel}`,
  ])
}
