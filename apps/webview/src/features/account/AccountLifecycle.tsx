import type { ReactElement } from 'react'
import type {
  AccountLifecycleErrorCodeDto,
  AccountLifecycleSnapshotDto,
  AccountSignOutImpactDto,
} from '@dsh-vscode/webview-protocol'

export type AccountLifecycleUiPhase =
  | 'initializing'
  | 'waiting-browser'
  | 'exchanging'
  | 'committing'
  | 'succeeded'
  | 'cancelled'
  | 'expired'
  | 'failed'

export type AccountLifecycleUiError = 'network' | 'protocol' | 'expired' | 'storage'
export type AccountLifecycleUiImpact = AccountSignOutImpactDto

/** Shape intentionally excludes browser URLs, callback values, and credential data. */
export type AccountLifecycleUiSnapshot = AccountLifecycleSnapshotDto

export interface AccountLifecycleLabels {
  readonly title: string
  readonly loading: string
  readonly signedOut: string
  readonly credentialStored: string
  readonly signIn: string
  readonly cancelSignIn: string
  readonly checkSignOutImpact: string
  readonly signOut: string
  readonly sessionExpired: string
  readonly requestFailed: string
  readonly retry: string
  readonly phases: Readonly<Record<AccountLifecycleUiPhase, string>>
  readonly errors: Readonly<Record<AccountLifecycleUiError, string>>
  readonly hostErrors: Readonly<Record<AccountLifecycleErrorCodeDto, string>>
  readonly impacts: Readonly<Record<AccountLifecycleUiImpact, string>>
}

export interface AccountLifecycleProps {
  readonly snapshot: AccountLifecycleUiSnapshot | null
  readonly impact?: AccountLifecycleUiImpact
  readonly sessionExpired?: boolean
  readonly hostError?: AccountLifecycleErrorCodeDto
  readonly requestFailed?: boolean
  readonly busy?: boolean
  readonly labels: AccountLifecycleLabels
  readonly onSignIn: () => void
  readonly onCancelSignIn: (attemptId: string) => void
  readonly onCheckSignOutImpact: () => void
  /** The Extension Host performs the authoritative confirmation before sign-out. */
  readonly onSignOut: () => void
  readonly onRetry: () => void
}

const CANCELLABLE_PHASES = new Set<AccountLifecycleUiPhase>(['initializing', 'waiting-browser', 'exchanging'])

/** Minimal account lifecycle surface. Profile, wallet, and bonus UI belong to separate slices. */
export function AccountLifecycle({
  snapshot,
  impact,
  sessionExpired = false,
  hostError,
  requestFailed = false,
  busy = false,
  labels,
  onSignIn,
  onCancelSignIn,
  onCheckSignOutImpact,
  onSignOut,
  onRetry,
}: AccountLifecycleProps): ReactElement {
  const attempt = snapshot?.attempt ?? null
  const activeAttempt = attempt !== null && CANCELLABLE_PHASES.has(attempt.phase)
  const canStart = snapshot?.status === 'signed-out' && !activeAttempt

  return (
    <section className="account-lifecycle" aria-labelledby="account-lifecycle-title" aria-busy={busy}>
      <h2 id="account-lifecycle-title">{labels.title}</h2>
      {snapshot === null ? (
        <p role="status" aria-live="polite">
          {labels.loading}
        </p>
      ) : (
        <>
          <p role="status" aria-live="polite">
            {snapshot.status === 'credential-stored' ? labels.credentialStored : labels.signedOut}
          </p>
          {sessionExpired ? <p role="alert">{labels.sessionExpired}</p> : null}
          {hostError === undefined ? null : <p role="alert">{labels.hostErrors[hostError]}</p>}
          {requestFailed ? (
            <div role="alert">
              <p>{labels.requestFailed}</p>
              <button type="button" disabled={busy} onClick={onRetry}>
                {labels.retry}
              </button>
            </div>
          ) : null}
          {attempt === null ? null : (
            <div className="account-lifecycle__attempt">
              <p>{labels.phases[attempt.phase]}</p>
              {attempt.errorCode === undefined ? null : (
                <p role="alert">{labels.errors[attempt.errorCode]}</p>
              )}
              {activeAttempt ? (
                <button type="button" disabled={busy} onClick={() => onCancelSignIn(attempt.id)}>
                  {labels.cancelSignIn}
                </button>
              ) : null}
            </div>
          )}
          {canStart ? (
            <button type="button" disabled={busy} onClick={onSignIn}>
              {labels.signIn}
            </button>
          ) : null}
          {snapshot.status === 'credential-stored' ? (
            <div className="account-lifecycle__sign-out">
              <button type="button" disabled={busy} onClick={onCheckSignOutImpact}>
                {labels.checkSignOutImpact}
              </button>
              {impact === undefined ? null : <p role="status">{labels.impacts[impact]}</p>}
              <button type="button" disabled={busy} onClick={onSignOut}>
                {labels.signOut}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
