import * as vscode from 'vscode'
import { DEFAULT_EDITOR_INTEGRATION, type EditorIntegrationPreferences } from '@dsh-vscode/domain'

export function readEditorPreferences(): EditorIntegrationPreferences {
  const settings = vscode.workspace.getConfiguration('dsh.editor', null)
  return {
    enabled: settings.get<boolean>('enabled') ?? DEFAULT_EDITOR_INTEGRATION.enabled,
    autoSetup: settings.get<boolean>('autoSetup') ?? DEFAULT_EDITOR_INTEGRATION.autoSetup,
    allowEdits: settings.get<boolean>('allowEdits') ?? DEFAULT_EDITOR_INTEGRATION.allowEdits,
  }
}
export async function saveEditorPreferences(change: Partial<EditorIntegrationPreferences>): Promise<void> {
  const settings = vscode.workspace.getConfiguration('dsh.editor', null)
  // Empty windows have no workspace configuration file. Keep their controls usable
  // in user settings; an open folder or saved workspace retains workspace scope.
  const target =
    vscode.workspace.workspaceFile !== undefined || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global
  for (const key of ['enabled', 'autoSetup', 'allowEdits'] as const) {
    if (change[key] !== undefined) await settings.update(key, change[key], target)
  }
}
