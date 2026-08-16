import assert from 'node:assert/strict'
import * as vscode from 'vscode'

export async function run() {
  const extension = vscode.extensions.getExtension('Direwolf.deepseek-harness-client')
  assert.ok(extension, 'the development extension must be installed')
  await extension.activate()
  const commands = await vscode.commands.getCommands(true)
  assert.ok(commands.includes('dsh.connect'))
  assert.ok(commands.includes('dsh.openInSecondarySidebar'))
  assert.equal(typeof globalThis.WebSocket, 'function', 'the Extension Host must provide WebSocket')
  console.log(
    `[dsh-vscode-e2e] extension-host node=${process.version} websocket=${typeof globalThis.WebSocket}`,
  )
  await vscode.commands.executeCommand('dsh.connect')
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  console.log('[dsh-vscode-e2e] dsh.connect completed')
}
