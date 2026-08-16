import type {
  BackendCandidate,
  BackendCapabilities,
  BackendEndpoint,
  ConnectedBackend,
  DshRuntime,
} from '@dsh-vscode/domain'

export function fakeEndpoint(port = 3939): BackendEndpoint {
  return { host: '127.0.0.1', port, baseUrl: `http://127.0.0.1:${port}` }
}

export function fakeCandidate(port = 3939): BackendCandidate {
  return { endpoint: fakeEndpoint(port), source: 'configured', confidence: 100 }
}

export function fakeCapabilities(): BackendCapabilities {
  return {
    protocolVersion: 'rc6',
    dshVersion: '0.1.0-rc.6',
    features: new Set(['sessions', 'workspaces', 'models', 'events']),
  }
}

export function fakeConnectedBackend(port = 3939): ConnectedBackend {
  return { endpoint: fakeEndpoint(port), ownership: 'external', capabilities: fakeCapabilities() }
}

export function fakeRuntime(): DshRuntime {
  return {
    executable: process.platform === 'win32' ? 'C:\\fake\\dsh.cmd' : '/fake/dsh',
    version: '0.1.0-rc.6',
    supported: true,
    source: 'configured',
  }
}
