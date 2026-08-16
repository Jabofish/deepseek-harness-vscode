import type { ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'

export interface AppErrorBoundaryProps {
  readonly children: ReactNode
}

interface AppErrorBoundaryState {
  readonly error: Error | undefined
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public override state: AppErrorBoundaryState = { error: undefined }

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    // TODO(implementation): replace with classified, redacted recovery states.
    return { error }
  }

  public override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // TODO(implementation): report a redacted renderer diagnostic to Extension Host.
  }

  public override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    // TODO(implementation): add Reload View and Show Diagnostics actions.
    return <section role="alert">The DeepSeek Harness view failed to render.</section>
  }
}
