import assert from 'node:assert/strict'
import http from 'node:http'
import * as vscode from 'vscode'

const ATTACH_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250
const EXTENSION_ID = 'Direwolf.deepseek-harness-client'

export async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(extension, 'the development extension must be installed')
  await extension.activate()
  const commands = await vscode.commands.getCommands(true)
  for (const command of ['dsh.connect', 'dsh.openInSecondarySidebar', 'dsh.openWebUi'])
    assert.ok(commands.includes(command), `the extension must register ${command}`)
  assert.equal(typeof globalThis.WebSocket, 'function', 'the Extension Host must provide WebSocket')
  console.log(
    `[dsh-vscode-e2e] extension-host node=${process.version} websocket=${typeof globalThis.WebSocket}`,
  )

  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the e2e workspace must be open')
  const settings = JSON.parse(
    new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json')),
    ),
  )
  const mode = settings['dsh.connection.mode']
  assert.ok(
    mode === 'attach-only' || mode === 'new-isolated',
    `unexpected DSH connection mode in the e2e workspace: ${String(mode)}`,
  )

  if (process.env.DSH_VSCODE_E2E_INVALID_SETTINGS === '1') {
    await assertInvalidSettingIsReported()
    return
  }

  await vscode.commands.executeCommand('dsh.connect')
  console.log('[dsh-vscode-e2e] dsh.connect completed')

  if (mode !== 'attach-only') {
    // In managed mode the extension owns a real runtime and never talks to the
    // attach fixture, so the wire-level assertions below do not apply. The
    // owned-process story is covered by tests/live-dsh/run.spec.ts.
    console.log('[dsh-vscode-e2e] managed mode: no attach fixture traffic expected')
  } else {
    const port = settings['dsh.connection.attachPorts']?.[0]
    assert.equal(typeof port, 'number', 'attach-only mode must record the fixture port')
    const observed = await waitForAttachObservations(port)
    console.log(
      `[dsh-vscode-e2e] attached methods=[${observed.methods.join(',')}] mux=${observed.muxUpgrades} host=${observed.hostUpgrades}`,
    )
  }
}

/**
 * The workspace was launched with an invalid `dsh.runtime.executablePath`, and
 * the extension is already activated with its commands registered by the time
 * this runs. The remaining claim is that the typo is reported per operation:
 * reading settings while the extension activates would have failed activation
 * instead, which needs a reload and a manual settings edit to recover.
 */
async function assertInvalidSettingIsReported() {
  let failure
  try {
    await vscode.commands.executeCommand('dsh.connect')
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'the extension must reject a connect while dsh.runtime.executablePath is invalid')
  const message = String(failure.message ?? failure)
  assert.match(
    message,
    /runtime\.executablePath/u,
    `the failure must name the invalid setting instead of a generic error: ${message}`,
  )
  console.log(`[dsh-vscode-e2e] invalid setting reported without losing the host: ${message}`)
}

async function waitForAttachObservations(port) {
  const deadline = Date.now() + ATTACH_TIMEOUT_MS
  let last
  for (;;) {
    try {
      last = await readObservations(port)
    } catch {
      last = undefined
    }
    if (last !== undefined && last.muxUpgrades >= 1 && last.hostUpgrades >= 1 && last.methods.length >= 1)
      return last
    assert.ok(
      Date.now() <= deadline,
      `the extension host never used the attach fixture: ${JSON.stringify(last)}`,
    )
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function readObservations(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/__e2e/observations' }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error('observation request timed out')))
  })
}
