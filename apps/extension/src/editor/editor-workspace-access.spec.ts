import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkspaceAccess } from './editor-workspace-access.js'

const ui = vi.hoisted(() => ({
  trusted: true,
  folders: [{ uri: { scheme: 'file' } }],
  info: vi.fn(),
  command: vi.fn(),
}))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return ui.trusted
    },
    get workspaceFolders() {
      return ui.folders
    },
  },
  window: { showInformationMessage: ui.info },
  commands: { executeCommand: ui.command },
}))
beforeEach(() => {
  ui.trusted = true
  ui.folders = [{ uri: { scheme: 'file' } }]
  ui.info.mockReset().mockResolvedValue(undefined)
  ui.command.mockReset().mockResolvedValue(undefined)
})

describe('editor access on first tool use', () => {
  it('opens native folder selection on first use, and remains blocked if no folder is chosen', async () => {
    ui.folders = []
    ui.info.mockResolvedValue('Choose Folder')
    const access = new EditorWorkspaceAccess(() => true)
    await expect(access.request(new AbortController().signal)).rejects.toMatchObject({
      reason: 'workspace-mismatch',
    })
    expect(ui.command).toHaveBeenCalledWith('workbench.action.addRootFolder')
    await expect(access.request(new AbortController().signal)).rejects.toMatchObject({
      reason: 'workspace-mismatch',
    })
    expect(ui.info).toHaveBeenCalledTimes(1)
    access.reset()
    ui.command.mockImplementation(() => {
      ui.folders = [{ uri: { scheme: 'file' } }]
      return Promise.resolve()
    })
    await access.request(new AbortController().signal)
    expect(access.reason()).toBeUndefined()
  })
  it('offers workspace trust without granting it, and resumes once VS Code reports trust', async () => {
    ui.trusted = false
    ui.info.mockResolvedValue('Manage Workspace Trust')
    const access = new EditorWorkspaceAccess(() => true)
    await expect(access.request(new AbortController().signal)).rejects.toMatchObject({ reason: 'untrusted' })
    expect(ui.command).toHaveBeenCalledWith('workbench.trust.manage')
    expect(ui.trusted).toBe(false)
    ui.trusted = true
    await access.request(new AbortController().signal)
  })
})
