import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as vscode from 'vscode'

const ATTACH_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250
const IDLE_OBSERVATION_MS = 4_000
const EXTENSION_ID = 'Jabofish.jabodsh'

export async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(extension, 'the development extension must be installed')
  assert.equal(extension.isActive, false, 'DSH must stay inactive until a view or command is requested')
  await extension.activate()
  const commands = await vscode.commands.getCommands(true)
  for (const command of [
    'dsh.connect',
    'dsh.openInSecondarySidebar',
    'dsh.openWebUi',
    'dsh.openChatInEditor',
    'dsh.moveChatToSidebar',
  ])
    assert.ok(commands.includes(command), `the extension must register ${command}`)
  // The editor chat surface is a restored webview panel, so no tab may exist
  // before the user asks for one.
  assert.equal(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType === 'dsh.chatPanel'),
    false,
    'no editor chat tab may be open before the user opens one',
  )
  assert.equal(typeof globalThis.WebSocket, 'function', 'the Extension Host must provide WebSocket')
  console.log(
    `[dsh-vscode-e2e] extension-host node=${process.version} websocket=${typeof globalThis.WebSocket}`,
  )

  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the e2e workspace must be open')
  const configuration = vscode.workspace.getConfiguration('dsh')
  const mode = process.env.DSH_VSCODE_E2E_EXPECTED_MODE
  assert.ok(
    mode === 'attach-only' || mode === 'new-isolated' || mode === 'auto',
    `unexpected DSH connection mode in the e2e runner: ${String(mode)}`,
  )
  const attachOnly = mode === 'attach-only'
  const fixturePort = Number(process.env.DSH_VSCODE_E2E_FIXTURE_PORT)
  assert.equal(configuration.get('connection.mode'), mode, 'VS Code must apply the requested mode')
  assert.equal(configuration.get('runtime.autoStart'), !attachOnly)
  if (attachOnly) {
    assert.ok(Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort <= 65535)
    assert.deepEqual(configuration.get('connection.attachPorts'), [fixturePort])
  } else {
    assert.equal(configuration.inspect('connection.attachPorts')?.globalValue, undefined)
  }
  const executable = process.env.DSH_VSCODE_E2E_EXPECTED_EXECUTABLE
  if (executable !== undefined) assert.equal(configuration.get('runtime.executablePath'), executable)
  if (!attachOnly) assertManagedIsolation(mode)

  if (process.env.DSH_VSCODE_E2E_INVALID_SETTINGS === '1') {
    await assertInvalidSettingIsReported()
    return
  }

  if (process.env.DSH_VSCODE_E2E_INSTALL_PREFIX !== undefined) await assertGuidedInstallation(mode)

  if (attachOnly) {
    await new Promise((resolve) => setTimeout(resolve, IDLE_OBSERVATION_MS))
    const beforeConnect = await readObservations(fixturePort)
    assert.deepEqual(
      {
        methods: beforeConnect.methods,
        muxUpgrades: beforeConnect.muxUpgrades,
        hostUpgrades: beforeConnect.hostUpgrades,
      },
      { methods: [], muxUpgrades: 0, hostUpgrades: 0 },
      'activating the extension without opening its view must not connect to DSH',
    )
    await vscode.commands.executeCommand('workbench.view.extension.dsh-container')
    await waitForAttachObservations(fixturePort)
    console.log('[dsh-vscode-e2e] opening the DSH view connected to the fixture')
  }

  const connection = await vscode.commands.executeCommand('dsh.connect')
  assert.deepEqual(connection, { connected: true }, 'the Extension Host must finish the real connection')
  console.log('[dsh-vscode-e2e] dsh.connect completed')

  // Moving to the sidebar explicitly focuses its view, so exercise it only
  // after the activation-without-a-view assertion above has completed.
  await vscode.commands.executeCommand('dsh.moveChatToSidebar')

  if (!attachOnly) {
    // In managed mode the extension owns a real runtime and never talks to the
    // attach fixture, so the wire-level assertions below do not apply.
    // Reconnecting exercises the owned start → stop → start path end to end.
    const reconnected = await vscode.commands.executeCommand('dsh.reconnect')
    assert.deepEqual(
      reconnected,
      { connected: true },
      'the Extension Host must stop the owned runtime and connect again',
    )
    console.log(`[dsh-vscode-e2e] ${mode}: connect and reconnect both completed against the owned runtime`)
    if (process.env.DSH_VSCODE_E2E_COMPANION === '1') await assertCompanionInstallation()
  } else {
    const observed = await waitForAttachObservations(fixturePort)
    console.log(
      `[dsh-vscode-e2e] attached methods=[${observed.methods.join(',')}] mux=${observed.muxUpgrades} host=${observed.hostUpgrades}`,
    )
  }
}

async function assertGuidedInstallation(mode) {
  const prefix = process.env.DSH_VSCODE_E2E_INSTALL_PREFIX
  const version = process.env.DSH_VSCODE_E2E_INSTALL_VERSION
  assert.equal(mode, 'new-isolated')
  assert.equal(prefix, path.join(path.dirname(process.env.DSH_HOME), 'npm-prefix'))
  assert.equal(prefix, process.env.npm_config_prefix)
  assert.match(version, /^\d+\.\d+\.\d+-rc\.\d+$/u)
  const packageJson = vscode.Uri.file(
    path.join(
      prefix,
      ...(process.platform === 'win32' ? [] : ['lib']),
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'package.json',
    ),
  )
  await assert.rejects(vscode.workspace.fs.stat(packageJson), { code: 'FileNotFound' })
  await vscode.commands.executeCommand('dsh.installRuntime')
  const installed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(packageJson)))
  assert.equal(installed.version, version)
  console.log(`[dsh-vscode-e2e] guided installation verified DSH ${version} in the isolated npm prefix`)
}

/** Real commands and files in the disposable profile, separate from DOM feedback tests. */
async function assertCompanionInstallation() {
  const profile = vscode.Uri.file(path.join(process.env.DSH_HOME, 'profiles', 'web'))
  const readJson = async (uri) =>
    JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)))
  const manifest = vscode.Uri.joinPath(profile, 'package.json')
  const name = '@dsh-vscode/editor-bridge'
  assert.equal(
    (await readJson(manifest)).dependencies?.[name],
    undefined,
    'the isolated profile starts without a companion',
  )
  const installation = await vscode.commands.executeCommand('dsh.installEditorCompanion')
  const first = (await readJson(manifest)).dependencies?.[name]
  assert.equal(
    typeof first,
    'string',
    `the first install must reach the actual DSH profile: ${JSON.stringify(installation)}`,
  )
  const repair = await vscode.commands.executeCommand('dsh.installEditorCompanion')
  const repaired = (await readJson(manifest)).dependencies?.[name]
  assert.equal(typeof repaired, 'string')
  assert.equal(installation.installed, true, JSON.stringify(installation))
  assert.equal(repair.installed, true, JSON.stringify(repair))
  assert.notEqual(repair.reason, 'setup-failed', JSON.stringify(repair))
  assert.notEqual(repair.installation, 'failed', JSON.stringify(repair))
  assert.notEqual(repair.installation, 'unknown', JSON.stringify(repair))
  assert.equal(repair.canInstall, true, JSON.stringify(repair))
  const installed = await readJson(
    vscode.Uri.joinPath(profile, 'node_modules', '@dsh-vscode', 'editor-bridge', 'package.json'),
  )
  assert.equal(installed.name, name)
  assert.equal(typeof installed.version, 'string')
  assert.deepEqual(await vscode.commands.executeCommand('dsh.reconnect'), { connected: true })
  assert.equal(
    (await readJson(manifest)).dependencies?.[name],
    repaired,
    'reconnection must retain the repaired companion',
  )
  console.log(
    '[dsh-vscode-e2e] companion: first install, repeat repair, actual package files and reconnect passed',
  )
}

/**
 * Any mode that starts a real runtime writes its state under `DSH_HOME`. The
 * runner creates a throwaway home and mirrors it here, so a mismatch means the
 * isolation was lost and the next start would use the user's own profile. This
 * matters more for `auto`, which also queries sources that ignore the home
 * entirely. Asserting before `dsh.connect` makes that fail before any runtime
 * exists.
 */
function assertManagedIsolation(mode) {
  const home = process.env.DSH_HOME
  assert.ok(home, `${mode} mode must run with DSH_HOME set to a test-owned home`)
  assert.equal(
    home,
    process.env.DSH_VSCODE_E2E_HOME,
    'the Extension Host must receive the isolated home the runner created',
  )
  const relative = path.relative(os.tmpdir(), home)
  assert.ok(
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
    `the isolated DSH home must live under the system temp directory: ${home}`,
  )
  console.log(`[dsh-vscode-e2e] ${mode} is isolated from the user DSH home`)
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
