import type { SessionSorting, WorkspaceDisplay } from './session-drawer-model.js'

interface SessionListPreferences {
  readonly sorting: SessionSorting
  readonly workspaceDisplay: WorkspaceDisplay
}

const storageKey = 'dsh-webview-session-list-preferences'
const defaults: SessionListPreferences = { sorting: 'manual', workspaceDisplay: 'current' }

export function readSessionListPreferences(): SessionListPreferences {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaults
    const record = value as Record<string, unknown>
    return {
      sorting: record.sorting === 'updated' ? 'updated' : 'manual',
      workspaceDisplay: record.workspaceDisplay === 'grouped' ? 'grouped' : 'current',
    }
  } catch {
    return defaults
  }
}

export function rememberSessionListPreferences(value: SessionListPreferences): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // A restricted Webview can still change the current list's presentation.
  }
}
