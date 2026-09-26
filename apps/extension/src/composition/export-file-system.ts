import type * as vscode from 'vscode'
import type { ExportFileSystem } from '@dsh-vscode/dsh-adapter'

export function createExportFileSystem(api: typeof vscode): ExportFileSystem {
  const uri = (filePath: string): vscode.Uri => api.Uri.file(filePath)
  return {
    stat: async (filePath) => {
      const info = await api.workspace.fs.stat(uri(filePath))
      return { isDirectory: () => (info.type & api.FileType.Directory) !== 0 }
    },
    rename: async (source, destination, overwrite = false) => {
      await api.workspace.fs.rename(uri(source), uri(destination), { overwrite })
    },
    unlink: async (filePath) => {
      await api.workspace.fs.delete(uri(filePath), { recursive: false, useTrash: false })
    },
    writeFile: async (filePath, data) => {
      await api.workspace.fs.writeFile(uri(filePath), data)
    },
  }
}
