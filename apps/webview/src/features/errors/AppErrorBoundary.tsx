import type { ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'
import { useI18n } from '../../i18n.js'

export interface AppErrorBoundaryProps {
  readonly children: ReactNode
}

interface AppErrorBoundaryState {
  readonly error: Error | undefined
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public override state: AppErrorBoundaryState = { error: undefined }

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  public override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Do not forward error objects or component stacks: they can contain user
    // paths and prompt text. The visible recovery action is sufficient here.
  }

  public override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    return <ErrorFallback />
  }
}

function ErrorFallback(): ReactNode {
  const { t } = useI18n()
  return (
    <section className="dsh-error-boundary" role="alert">
      <h1>{t('errorBoundary.title')}</h1>
      <p>{t('errorBoundary.description')}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {t('errorBoundary.reload')}
      </button>
    </section>
  )
}
