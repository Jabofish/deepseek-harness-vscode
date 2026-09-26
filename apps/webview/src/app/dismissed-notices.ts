const WELCOME_DISMISSED_KEY = 'dsh-welcome-dismissed'
const RUNTIME_UPDATE_DISMISSED_KEY = 'dsh-runtime-update-dismissed-version'

export function welcomeWasDismissed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(WELCOME_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberWelcomeDismissal(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WELCOME_DISMISSED_KEY, '1')
  } catch {
    // A restricted Webview storage area should not prevent starting a session.
  }
}

export function dismissedRuntimeUpdateVersionFromStorage(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const value = window.localStorage.getItem(RUNTIME_UPDATE_DISMISSED_KEY)?.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

export function rememberRuntimeUpdateDismissal(version: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RUNTIME_UPDATE_DISMISSED_KEY, version)
  } catch {
    // A restricted Webview storage area should not prevent using the update notice.
  }
}
