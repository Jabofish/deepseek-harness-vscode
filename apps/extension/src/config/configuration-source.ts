import type * as vscode from 'vscode'
import type { ExtensionSettings } from '@dsh-vscode/domain'
import { AppError, type AgentConfiguration } from '@dsh-vscode/domain'

export class VsCodeConfigurationSource {
  public constructor(private readonly workspace: typeof vscode.workspace) {}

  public read(): ExtensionSettings {
    const config = this.workspace.getConfiguration('dsh')
    const mode = readEnum(
      config.get<unknown>('connection.mode', 'auto'),
      ['auto', 'custom', 'attach-only', 'new-isolated'] as const,
      'connection.mode',
    )
    const managedPort = readPort(
      config.get<unknown>('connection.managedPort', 0),
      true,
      'connection.managedPort',
    )
    const attachPorts = readPorts(
      config.get<unknown>('connection.attachPorts', [3080]),
      'connection.attachPorts',
    )
    const discoveryTimeoutMs = readInteger(
      config.get<unknown>('connection.discoveryTimeoutMs', 1500),
      100,
      30_000,
      'connection.discoveryTimeoutMs',
    )
    const requestTimeoutMs = readInteger(
      config.get<unknown>('connection.requestTimeoutMs', 30_000),
      1_000,
      300_000,
      'connection.requestTimeoutMs',
    )
    const serverUrl = normalizeLoopbackUrl(config.get<unknown>('connection.serverUrl', ''))
    const executablePath = readOptionalPath(config.get<unknown>('runtime.executablePath', ''))
    const preset = readString(config.get<unknown>('agent.defaultPreset', 'standard'), 'agent.defaultPreset')
    const toolMode = readEnum(
      config.get<unknown>('agent.toolMode', 'native'),
      ['native', 'code', 'both'] as const,
      'agent.toolMode',
    )
    const permissionPreset = readString(
      config.get<unknown>('agent.permissionPreset', 'workspace-write'),
      'agent.permissionPreset',
    )
    const providerId = readString(config.get<unknown>('model.provider', ''), 'model.provider')
    const modelId = readString(config.get<unknown>('model.id', ''), 'model.id')
    const reasoningLevel = readString(config.get<unknown>('model.reasoningLevel', ''), 'model.reasoningLevel')
    const defaultAgent: AgentConfiguration = {
      preset,
      toolMode,
      permissionPreset,
      planMode: readBoolean(config.get<unknown>('agent.planMode', false), 'agent.planMode'),
      model: { providerId, modelId, ...(reasoningLevel === '' ? {} : { reasoningLevel }) },
    }
    return {
      connection: {
        mode,
        host: '127.0.0.1',
        ...(serverUrl === undefined ? {} : { serverUrl }),
        managedPort,
        attachPorts,
        discoveryTimeoutMs,
        requestTimeoutMs,
      },
      runtime: {
        executablePath,
        autoStart: readBoolean(config.get<unknown>('runtime.autoStart', true), 'runtime.autoStart'),
        installPackage: '@deepseek-ai/dsh',
      },
      security: {
        defaultPermissionPreset: permissionPreset,
        allowRemoteHost: false,
        redactDiagnostics: true,
      },
      defaultAgent,
    }
  }

  public onDidChange(listener: () => void): vscode.Disposable {
    return this.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dsh')) listener()
    })
  }
}

function readString(value: unknown, key: string): string {
  if (typeof value !== 'string') invalid(key, 'a string')
  return value
}

function readBoolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') invalid(key, 'a boolean')
  return value
}

function readInteger(value: unknown, min: number, max: number, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    invalid(key, `an integer from ${min} to ${max}`)
  return value
}

function readPort(value: unknown, allowZero: boolean, key: string): number {
  return readInteger(value, allowZero ? 0 : 1, 65_535, key)
}

function readPorts(value: unknown, key: string): readonly number[] {
  if (!Array.isArray(value)) invalid(key, 'an array of ports')
  return [...new Set(value.map((entry) => readPort(entry, false, key)))]
}

function readEnum<const T extends readonly string[]>(value: unknown, allowed: T, key: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(key, `one of ${allowed.join(', ')}`)
  return value
}

function readOptionalPath(value: unknown): string | undefined {
  if (typeof value !== 'string') invalid('runtime.executablePath', 'a string')
  if (value === '') return undefined
  if (!isAbsolutePath(value)) invalid('runtime.executablePath', 'an absolute path')
  return value
}

export function normalizeLoopbackUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') invalid('connection.serverUrl', 'a string')
  if (value.trim() === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalid('connection.serverUrl', 'an http loopback URL')
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') ||
    !/^\d+$/.test(parsed.port) ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535 ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    invalid('connection.serverUrl', 'an http loopback URL')
  return `http://${parsed.hostname}:${parsed.port}`
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function invalid(key: string, expected: string): never {
  throw new AppError({
    code: 'INVALID_CONFIGURATION',
    message: `Invalid DSH setting ${key}; expected ${expected}.`,
    retryable: false,
  })
}
