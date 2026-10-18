import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { BackendState } from '@dsh-vscode/domain'
import { openDshWebUi } from './open-web-ui.js'

vi.mock('vscode', () => ({}))

const endpoint = { baseUrl: 'http://127.0.0.1:4317', host: '127.0.0.1', port: 4317, protocol: 'http' }
const connected = { kind: 'connected', backend: { endpoint } } as unknown as BackendState
const launchUrl = `${endpoint.baseUrl}/?token=fixture-login`
// vscode.Uri.toString() aggressively encodes query delimiters unless skipEncoding is true.
interface TestUri {
  readonly scheme: string
  readonly toString: (skipEncoding?: boolean) => string
}
const parse = (value: string): TestUri => ({
  scheme: new URL(value).protocol.slice(0, -1),
  toString: (skipEncoding = false) =>
    skipEncoding ? value : value.replace(/=/g, '%3D').replace(/&/g, '%26'),
})

interface BrowserHarness {
  readonly host: NonNullable<Parameters<typeof openDshWebUi>[2]>
  readonly executeCommand: Mock<(command: string, ...args: unknown[]) => Promise<void>>
  readonly openExternal: Mock<(uri: TestUri) => Promise<boolean>>
  readonly asExternalUri: Mock<(uri: TestUri) => Promise<TestUri>>
  readonly get: Mock<(key: string, fallback: unknown) => unknown>
  readonly showWarningMessage: Mock<() => Promise<string | undefined>>
  readonly showInformationMessage: Mock<() => Promise<void>>
}

function harness(target: unknown = 'internal', remoteName?: string): BrowserHarness {
  const executeCommand = vi.fn<BrowserHarness['executeCommand']>().mockResolvedValue(undefined)
  const openExternal = vi.fn<BrowserHarness['openExternal']>().mockResolvedValue(true)
  const asExternalUri = vi
    .fn<BrowserHarness['asExternalUri']>()
    .mockResolvedValue(parse('http://127.0.0.1:5432/?token=fixture-login'))
  const get = vi.fn((_key: string, fallback: unknown) => target ?? fallback)
  const showWarningMessage = vi.fn<BrowserHarness['showWarningMessage']>().mockResolvedValue(undefined)
  const showInformationMessage = vi
    .fn<BrowserHarness['showInformationMessage']>()
    .mockResolvedValue(undefined)
  const host = {
    commands: { executeCommand },
    env: { remoteName, openExternal, asExternalUri },
    workspace: { getConfiguration: vi.fn(() => ({ get })) },
    window: { showWarningMessage, showInformationMessage },
    Uri: { parse },
  }
  return {
    host: host as unknown as NonNullable<Parameters<typeof openDshWebUi>[2]>,
    executeCommand,
    openExternal,
    asExternalUri,
    get,
    showWarningMessage,
    showInformationMessage,
  }
}

describe('title-bar DSH Web UI browser', () => {
  it('defaults to the integrated browser and preserves the managed login URL', async () => {
    const ui = harness(undefined)
    await openDshWebUi(connected, new Map([[endpoint.baseUrl, launchUrl]]), ui.host)
    expect(ui.get).toHaveBeenCalledWith('webUi.browser', 'internal')
    expect(ui.executeCommand).toHaveBeenCalledExactlyOnceWith('workbench.action.browser.open', launchUrl)
    expect(ui.openExternal).not.toHaveBeenCalled()
    expect(ui.asExternalUri).not.toHaveBeenCalled()
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      readonly contributes: {
        readonly configuration: { readonly properties: Readonly<Record<string, unknown>> }
      }
    }
    expect(manifest.contributes.configuration.properties['dsh.webUi.browser']).toMatchObject({
      enum: ['internal', 'external'],
      default: 'internal',
      scope: 'application',
    })
  })

  it('honors a changed browser choice on the next click without a reconnect', async () => {
    const ui = harness('external')
    await openDshWebUi(connected, new Map(), ui.host)
    expect(ui.openExternal.mock.calls[0]?.[0].toString(true)).toBe(endpoint.baseUrl)
    expect(ui.executeCommand).not.toHaveBeenCalled()
    ui.get.mockReturnValue('internal')
    await openDshWebUi(connected, new Map(), ui.host)
    expect(ui.executeCommand).toHaveBeenCalledWith('workbench.action.browser.open', endpoint.baseUrl)
  })

  it.each(['ssh-remote', 'dev-container'])(
    'forwards a %s loopback URL before opening',
    async (remoteName) => {
      const ui = harness('internal', remoteName)
      await openDshWebUi(connected, new Map([[endpoint.baseUrl, launchUrl]]), ui.host)
      expect(ui.asExternalUri.mock.calls[0]?.[0].toString(true)).toBe(launchUrl)
      expect(ui.executeCommand).toHaveBeenCalledExactlyOnceWith(
        'workbench.action.browser.open',
        'http://127.0.0.1:5432/?token=fixture-login',
      )
    },
  )

  it('does not try to tunnel an explicitly configured remote server', async () => {
    const ui = harness('internal', 'ssh-remote')
    const state = {
      kind: 'connected',
      backend: {
        endpoint: {
          baseUrl: 'https://dsh.example.test:443',
          host: 'dsh.example.test',
          port: 443,
          protocol: 'https',
        },
      },
    } as unknown as BackendState
    await openDshWebUi(state, new Map(), ui.host)
    expect(ui.asExternalUri).not.toHaveBeenCalled()
    expect(ui.executeCommand).toHaveBeenCalledWith(
      'workbench.action.browser.open',
      'https://dsh.example.test:443',
    )
  })

  it('keeps a disconnected click from opening a stale launch URL', async () => {
    const ui = harness()
    await openDshWebUi({ kind: 'idle' }, new Map([[endpoint.baseUrl, launchUrl]]), ui.host)
    expect(ui.showInformationMessage).toHaveBeenCalledOnce()
    expect(ui.openExternal).not.toHaveBeenCalled()
    expect(ui.executeCommand).not.toHaveBeenCalled()
  })

  it.each(['internal', 'external', 'forwarding', 'invalid', 'scheme'])(
    'handles %s failure without exposing login details or changing browser',
    async (failure) => {
      const ui = harness(
        failure === 'invalid' ? 'unexpected' : failure === 'external' ? 'external' : 'internal',
        failure === 'forwarding' || failure === 'scheme' ? 'ssh-remote' : undefined,
      )
      if (failure === 'internal') ui.executeCommand.mockRejectedValueOnce(new Error(launchUrl))
      if (failure === 'external') ui.openExternal.mockResolvedValue(false)
      if (failure === 'forwarding') ui.asExternalUri.mockRejectedValue(new Error(launchUrl))
      if (failure === 'scheme') ui.asExternalUri.mockResolvedValue(parse('command:untrusted'))
      ui.showWarningMessage.mockResolvedValue('Open Browser Settings')
      await openDshWebUi(connected, new Map([[endpoint.baseUrl, launchUrl]]), ui.host)
      expect(ui.showWarningMessage).toHaveBeenCalledOnce()
      expect(JSON.stringify(ui.showWarningMessage.mock.calls)).not.toContain('fixture-login')
      expect(ui.executeCommand).toHaveBeenLastCalledWith('workbench.action.openSettings', 'dsh.webUi.browser')
      if (failure !== 'external') expect(ui.openExternal).not.toHaveBeenCalled()
    },
  )
})
