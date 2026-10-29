import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import * as vscode from 'vscode'
import { parseServerOrigin } from '@dsh-vscode/domain'
import { redactMultilineText } from '@dsh-vscode/dsh-adapter'
import { createCredentialScope } from '../../../apps/extension/src/backend/credential-scope.js'
import { ExternalConnectionAccess } from '../../../apps/extension/src/backend/external-connection-access.js'
import { EndpointNetwork } from '../../../apps/extension/src/backend/endpoint-network.js'
import {
  EditorContextProvider,
  DSH_CHAT_VIEW_OWNER_ID,
} from '../../../apps/extension/src/editor/editor-context-provider.js'
import { workspaceFolderId } from '../../../apps/extension/src/editor/workspace-path-guard.js'
import { createVscodeCheckpointWorkspace } from '../../../apps/extension/src/checkpoints/vscode-checkpoint-adapter.js'
import { createVscodeWorkspacePromptTemplateStorage } from '../../../apps/extension/src/prompts/vscode-prompt-template-adapter.js'
import { inspectorClientUrl } from '../../../apps/extension/src/composition/inspector-client-url.js'

interface RemoteResult {
  status: 'running' | 'passed' | 'failed'
  remoteName: string | undefined
  vscodeVersion: string
  nodeVersion: string
  runtimeVersion: string
  checks: string[]
  clientStoreShared?: boolean
  foreignHostGrantPresent?: boolean
  forwardedFixtureUrl?: string
  failure?: string
}

/** This test extension is built separately and is never included in the product VSIX. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'The test-owned remote workspace must be open.')
  const markerUri = vscode.Uri.joinPath(folder.uri, '.dsh-remote-fixture.json')
  const marker = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(markerUri)).toString('utf8')) as {
    remoteName: string
    runtimeVersion: string
  }
  const result: RemoteResult = {
    status: 'running',
    remoteName: vscode.env.remoteName,
    vscodeVersion: vscode.version,
    nodeVersion: process.version,
    runtimeVersion: marker.runtimeVersion,
    checks: [],
  }
  const resultUri = vscode.Uri.joinPath(folder.uri, '.dsh-remote-result.json')
  const publish = async (): Promise<void> => {
    await vscode.workspace.fs.writeFile(resultUri, Buffer.from(JSON.stringify(result, null, 2)))
  }
  const check = async (name: string, operation: () => Promise<void>): Promise<void> => {
    await operation()
    result.checks.push(name)
    await publish()
  }
  try {
    await check('remote-host-location', async () => {
      assert.equal(vscode.env.remoteName, marker.remoteName)
      assert.equal(process.platform, 'linux')
      assert.equal(folder.uri.scheme, 'file', 'VS Code must transform the remote workspace URI for its Host.')
      assert.ok(vscode.workspace.isTrusted)
      const home = process.env.DSH_HOME
      assert.ok(
        home && home.startsWith(`${os.tmpdir()}${path.sep}`),
        'DSH must use a test-owned temporary home.',
      )
      const extension = vscode.extensions.getExtension('Jabofish.jabodsh')
      assert.ok(extension, 'The product extension must be installed remotely.')
      assert.equal(extension.extensionKind, vscode.ExtensionKind.Workspace)
      await extension.activate()
      const runtime = await promisify(execFile)('/usr/local/bin/dsh', ['--version'], { timeout: 3000 })
      assert.equal(runtime.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)?.[0], marker.runtimeVersion)
    })
    await check('product-managed-connect', async () => {
      assert.deepEqual(await vscode.commands.executeCommand('dsh.connect'), { connected: true })
    })
    await check('product-managed-reconnect', async () => {
      assert.deepEqual(await vscode.commands.executeCommand('dsh.reconnect'), { connected: true })
    })
    const id = workspaceFolderId(folder)
    const fileUri = vscode.Uri.joinPath(folder.uri, 'fixture.txt')
    await check('remote-files-editor-context-navigation', async () => {
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from('remote fixture\n'))
      const document = await vscode.workspace.openTextDocument(fileUri)
      await vscode.window.showTextDocument(document)
      const provider = new EditorContextProvider()
      context.subscriptions.push(provider)
      const owner = {
        ownerId: DSH_CHAT_VIEW_OWNER_ID,
        ownerViewId: DSH_CHAT_VIEW_OWNER_ID,
        contextStoreGeneration: 1,
        workspaceFolderId: id,
      }
      const item = await provider.capture({ kind: 'file', workspaceFolderId: id }, owner)
      assert.equal((await provider.preview(item.ref.contextRef, owner)).text, 'remote fixture\n')
      assert.equal(item.ref.relativePath, 'fixture.txt')
    })
    await check('remote-checkpoint-filesystem-and-template-storage', async () => {
      const workspace = createVscodeCheckpointWorkspace()
      assert.equal(Buffer.from((await workspace.readFile(id, 'fixture.txt'))!).toString(), 'remote fixture\n')
      await workspace.writeFile(id, 'fixture-copy.txt', Buffer.from('copy fixture'))
      await workspace.renameFile(id, 'fixture-copy.txt', 'fixture-renamed.txt', false)
      assert.equal(
        Buffer.from((await workspace.readFile(id, 'fixture-renamed.txt'))!).toString(),
        'copy fixture',
      )
      await workspace.deleteFile(id, 'fixture-renamed.txt')
      const templates = createVscodeWorkspacePromptTemplateStorage(id)
      assert.ok(templates)
      await templates.mkdir()
      await templates.write('fixture.json', Buffer.from('{"fixture":true}'))
      assert.equal(Buffer.from((await templates.read('fixture.json'))!).toString(), '{"fixture":true}')
    })
    await check('real-client-secret-storage-environment-isolation', async () => {
      const scope = createCredentialScope(context.globalStorageUri.fsPath)
      const currentScope = await scope()
      assert.equal(currentScope, await createCredentialScope(context.globalStorageUri.fsPath)())
      const previousGrantText = await context.secrets.get('fixture-shared-origin-grant')
      const previousGrant =
        previousGrantText === undefined
          ? undefined
          : (JSON.parse(previousGrantText) as { scope: string; port: number })
      result.clientStoreShared = previousGrant !== undefined
      result.foreignHostGrantPresent = previousGrant !== undefined && previousGrant.scope !== currentScope
      if (previousGrant !== undefined) {
        assert.match(previousGrant.scope, /^[0-9a-f]{32}$/u)
        assert.ok(
          Number.isInteger(previousGrant.port) && previousGrant.port >= 31001 && previousGrant.port < 65535,
        )
      }
      // A different Host must try the same origin before deleting or authorizing
      // anything. Clearing first would conceal an unscoped-credential regression.
      const port =
        previousGrant === undefined
          ? 31001
          : previousGrant.scope === currentScope
            ? previousGrant.port + 1
            : previousGrant.port
      let requests = 0
      const endpoint = parseServerOrigin(`http://127.0.0.1:${port}`)
      assert.ok(endpoint)
      const network = new EndpointNetwork({
        fetch: () => {
          requests++
          return Promise.resolve(
            new Response(null, {
              status: 303,
              headers: {
                location: './',
                'set-cookie':
                  'dsh-auth-fixture=session-fixture; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600',
              },
            }),
          )
        },
      })
      const access = new ExternalConnectionAccess({
        secrets: context.secrets,
        credentialScope: scope,
        network,
        isTrusted: () => true,
        requestTimeoutMs: () => 5000,
        confirm: () => Promise.resolve(true),
        inputToken: () => Promise.resolve('fake-remote-fixture-token'),
      })
      try {
        await access.prepare(endpoint, new AbortController().signal)
        assert.equal(requests, 0, 'Another remote environment must not supply credentials.')
        await access.authorize(endpoint)
        await access.prepare(endpoint, new AbortController().signal)
        assert.equal(requests, 1)
        await context.secrets.store(
          'fixture-shared-origin-grant',
          JSON.stringify({ scope: currentScope, port }),
        )
      } finally {
        await access.dispose()
      }
    })
    await check('native-remote-inspector-tunnel', async () => {
      const server = createServer((_request, response) => response.end('remote-tunnel-fixture'))
      context.subscriptions.push({
        dispose: () => {
          server.close()
        },
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const frontend = await inspectorClientUrl(
        `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${address.port}/devtools/page/fixture`,
        new AbortController().signal,
      )
      const client = new URL(frontend).searchParams.get('ws')
      assert.ok(client)
      result.forwardedFixtureUrl = `http://${client}`
    })
    await vscode.commands.executeCommand('workbench.view.extension.dsh-container')
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.failure = redactMultilineText(error instanceof Error ? error.message : String(error), 1024)
  }
  await publish()
}
