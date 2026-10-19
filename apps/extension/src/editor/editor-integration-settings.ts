import * as vscode from 'vscode'
import { DEFAULT_EDITOR_INTEGRATION, type EditorIntegrationPreferences } from '@dsh-vscode/domain'

export function readEditorPreferences(): EditorIntegrationPreferences {
  const settings = vscode.workspace.getConfiguration('dsh.editor')
  return {
    enabled: settings.get<boolean>('enabled') ?? DEFAULT_EDITOR_INTEGRATION.enabled,
    autoSetup: settings.get<boolean>('autoSetup') ?? DEFAULT_EDITOR_INTEGRATION.autoSetup,
    allowEdits: settings.get<boolean>('allowEdits') ?? DEFAULT_EDITOR_INTEGRATION.allowEdits,
  }
}
export async function saveEditorPreferences(change: Partial<EditorIntegrationPreferences>): Promise<void> {
  const settings = vscode.workspace.getConfiguration('dsh.editor')
  // One workspace preference applies to every session and survives reconnection/reload.
  for (const key of ['enabled', 'autoSetup', 'allowEdits'] as const) {
    if (change[key] !== undefined)
      await settings.update(key, change[key], vscode.ConfigurationTarget.Workspace)
  }
}
