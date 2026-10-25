export type ActivityPresentation = 'auto' | 'live' | 'quiet'
export const ACTIVITY_PRESENTATION_STORAGE_KEY = 'dsh-webview-activity-presentation'
export const ACTIVITY_PRESENTATION_OPTIONS: readonly ActivityPresentation[] = ['auto', 'live', 'quiet']

export function isActivityPresentation(value: unknown): value is ActivityPresentation {
  return ACTIVITY_PRESENTATION_OPTIONS.some((option) => option === value)
}

export function readActivityPresentation(): ActivityPresentation {
  try {
    const value = window.localStorage.getItem(ACTIVITY_PRESENTATION_STORAGE_KEY)
    return isActivityPresentation(value) ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export function rememberActivityPresentation(value: ActivityPresentation): void {
  try {
    window.localStorage.setItem(ACTIVITY_PRESENTATION_STORAGE_KEY, value)
  } catch {
    // A storage failure must not block the user's display choice.
  }
}
