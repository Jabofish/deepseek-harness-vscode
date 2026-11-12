import type { AccountClientMetadata, AccountNotification } from '@dsh-vscode/domain'
import type { AccountLifecycleUseCases } from '@dsh-vscode/application'

export interface AccountNotificationHostDependencies {
  readonly useCases: AccountLifecycleUseCases
  readonly client: () => AccountClientMetadata
  /** Host-native plain-text notification; result indexes the exact actions supplied. */
  readonly present: (notice: AccountNotification) => Promise<number | undefined>
  readonly openAccount: () => Promise<void>
  readonly reportError: () => void
}

/** One polling lifetime per credential revision. No notification data enters the Webview. */
export class AccountNotificationHost {
  private readonly lifetime = new AbortController()
  private readonly displayed = new Set<string>()
  private readonly task: Promise<void>

  public constructor(private readonly dependencies: AccountNotificationHostDependencies) {
    this.task = this.poll(this.lifetime.signal)
  }

  public async dispose(): Promise<void> {
    this.lifetime.abort()
    this.displayed.clear()
    await this.task
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let delay = 60_000
      try {
        const batch = await this.dependencies.useCases.readNotifications(this.dependencies.client(), signal)
        if (signal.aborted) return
        if (batch === null) return
        delay = Math.max(1_000, batch.nextPollAfterSeconds * 1_000)
        for (const notice of batch.notifications) {
          if (signal.aborted) return
          if (
            this.displayed.has(notice.id) ||
            (notice.displayUntil !== null && Date.parse(notice.displayUntil) <= Date.now())
          )
            continue
          // Bound presentation history for this grant without re-presenting older notices.
          if (this.displayed.size >= 1_024) break
          this.displayed.add(notice.id)
          void this.present(notice, signal).catch(() => {
            if (!signal.aborted) this.report()
          })
        }
      } catch {
        if (signal.aborted) return
        this.report()
      }
      await waitForPoll(delay, signal)
    }
  }

  private async present(notice: AccountNotification, signal: AbortSignal): Promise<void> {
    const choice = waitForChoice(this.dependencies.present(notice), signal).then(
      (value) => ({ value, failed: false }),
      () => ({ value: undefined, failed: true }),
    )
    // VS Code has accepted the presentation. Event reporting never consumes a
    // notification locally: only Platform decides whether it remains offered.
    try {
      await this.dependencies.useCases.reportNotificationEvent(
        notice.id,
        'displayed',
        this.dependencies.client(),
        signal,
      )
    } catch {
      if (!signal.aborted) this.report()
    }
    const result = await choice
    if (signal.aborted) return
    if (result.failed) throw new Error('Account notification presentation failed.')
    const selected = result.value
    if (signal.aborted || selected === undefined || !Number.isInteger(selected)) return
    const action = notice.actions[selected]
    if (
      action === undefined ||
      (notice.displayUntil !== null && Date.parse(notice.displayUntil) <= Date.now())
    )
      return
    const reporting = this.dependencies.useCases
      .reportNotificationEvent(
        notice.id,
        action.target === 'dismiss' ? 'dismissed' : 'cta_clicked',
        this.dependencies.client(),
        signal,
      )
      .catch(() => false)
    try {
      if (action.target === 'account') await this.dependencies.openAccount()
      if (!(await reporting) && !signal.aborted) this.report()
    } catch {
      await reporting.catch(() => undefined)
      throw new Error('Account notification action failed.')
    }
  }

  private report(): void {
    try {
      this.dependencies.reportError()
    } catch {
      /* Diagnostic sinks cannot break polling or cleanup. */
    }
  }
}

function waitForChoice(
  choice: Promise<number | undefined>,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      resolve(undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    void choice.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error('Account notification presentation failed.'))
      },
    )
  })
}

function waitForPoll(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delay)
    signal.addEventListener('abort', finish, { once: true })
  })
}
