// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DshUpdateSnapshot,
  ExtensionSettingsSummary,
  ModelDescriptor,
  ModelProvider,
} from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { I18nProvider } from '../../i18n.js'
import { SettingsDrawer } from './SettingsDrawer.js'

const baseProvider: ModelProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'remote',
  configurable: true,
  fields: [
    { key: 'apiKeyEnv', label: 'API key', secret: true, required: true, writable: true },
    {
      key: 'baseUrl',
      label: 'Base URL',
      secret: false,
      required: false,
      value: 'https://api.deepseek.com',
    },
  ],
}

const providers: readonly ModelProvider[] = [baseProvider]

const models: readonly ModelDescriptor[] = [
  {
    id: 'deepseek-chat',
    providerId: 'deepseek',
    label: 'DeepSeek Chat',
    contextWindow: 128_000,
    supportsReasoning: false,
  },
  {
    id: 'deepseek-reasoner',
    providerId: 'deepseek',
    label: 'DeepSeek Reasoner',
    contextWindow: 64_000,
    supportsReasoning: true,
  },
]

function settingsFixture(): ExtensionSettingsSummary {
  return {
    connection: { mode: 'new-isolated', customEndpointConfigured: false },
    runtime: { customExecutableConfigured: false, autoStart: true },
    security: { defaultPermissionPreset: 'workspace-write' },
    defaultAgent: {
      preset: 'standard',
      toolMode: 'native',
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    },
  }
}

function dshSettingsFixture(): DshSettingsSnapshot {
  return {
    schema: {
      version: 'rc6-settings-v2',
      writable: true,
      hasDocument: false,
      fields: [
        {
          path: 'permission.defaultPreset',
          label: 'defaultPreset',
          type: 'enum',
          required: true,
          enumValues: ['read-only', 'workspace-write', 'danger-full-access'],
          restartRequired: false,
        },
        {
          path: 'locale.preference',
          label: 'preference',
          type: 'enum',
          required: false,
          enumValues: ['zh', 'en'],
          restartRequired: false,
        },
        {
          path: 'ui-theme.preference',
          label: 'preference',
          type: 'enum',
          required: false,
          enumValues: ['light', 'dark', 'system'],
          restartRequired: false,
        },
        {
          path: 'ui-conversation.busyEnter',
          label: 'busyEnter',
          type: 'enum',
          required: false,
          enumValues: ['queue', 'steer'],
          restartRequired: false,
        },
        {
          path: 'shell.timeoutMs',
          label: 'timeoutMs',
          type: 'number',
          required: false,
          restartRequired: true,
        },
      ],
      namespaces: [
        { ns: 'permission', applies: 'live', userFields: ['defaultPreset'], secrets: [] },
        { ns: 'shell', applies: 'restart', userFields: ['timeoutMs'], secrets: [] },
      ],
    },
    values: {
      permission: { defaultPreset: 'workspace-write' },
      'ui-conversation': { busyEnter: 'queue' },
    },
  }
}

function renderDrawer(
  overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {},
  localized = false,
): ReturnType<typeof render> {
  const drawer = (
    <SettingsDrawer
      open
      onOpenChange={vi.fn()}
      connected
      connectedDshVersion="0.6.0"
      onConfigureConnection={vi.fn().mockResolvedValue(undefined)}
      providers={providers}
      models={models}
      onLoadSettings={vi.fn().mockResolvedValue(settingsFixture())}
      onLoadDshSettings={vi.fn().mockResolvedValue(dshSettingsFixture())}
      onOpenDshSettingsDocument={vi.fn().mockResolvedValue(undefined)}
      onUpdateDshSetting={vi.fn().mockResolvedValue(undefined)}
      onUnsetDshSetting={vi.fn().mockResolvedValue(undefined)}
      onDiscoverModels={vi.fn().mockResolvedValue([])}
      onConfigureSecret={vi.fn().mockResolvedValue(true)}
      onRemoveSecret={vi.fn().mockResolvedValue(undefined)}
      onRefreshCatalog={vi.fn().mockResolvedValue(undefined)}
      onLoadPresetRoster={vi.fn().mockResolvedValue(undefined)}
      onReadPresetDocument={vi.fn().mockResolvedValue(undefined)}
      onCopyPreset={vi.fn().mockResolvedValue(undefined)}
      onRemovePreset={vi.fn().mockResolvedValue(undefined)}
      onOpenPresetDocument={vi.fn().mockResolvedValue(undefined)}
      onLoadPluginInventory={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />
  )
  return render(localized ? <I18nProvider>{drawer}</I18nProvider> : drawer)
}

describe('SettingsDrawer', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('localizes general and model settings when Chinese is selected', async () => {
    window.localStorage.setItem('dsh-webview-locale', 'zh')
    renderDrawer({}, true)

    expect(await screen.findByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '常规' })).toBeDefined()
    expect(screen.getByText('连接模式')).toBeDefined()
    expect(screen.getByRole('group', { name: '语言' })).toBeDefined()
    expect(screen.getByRole('button', { name: '中文' })).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: '模型' }))
    expect(screen.getByText('1 个 Provider · 2 个模型')).toBeDefined()
    expect(screen.getByText('缺失')).toBeDefined()
    expect(screen.getByRole('button', { name: '配置' })).toBeDefined()
  })

  it('loads and renders general settings facts', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    expect(screen.getByText('0.6.0')).toBeDefined()
    expect(screen.getByText('deepseek/deepseek-chat')).toBeDefined()
  })

  it('applies a custom loopback endpoint and reconnects through the Host', async () => {
    const onConfigureConnection = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onConfigureConnection })

    await screen.findByRole('heading', { name: 'DSH connection' })
    fireEvent.click(screen.getByRole('radio', { name: /Custom endpoint/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Service endpoint' }), {
      target: { value: 'http://127.0.0.1:4310' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply and reconnect' }))

    await waitFor(() => expect(onConfigureConnection).toHaveBeenCalledWith('custom', 'http://127.0.0.1:4310'))
    expect(await screen.findByRole('status', { name: '' })).toBeDefined()
  })

  it('requires an endpoint before applying custom mode', async () => {
    const onConfigureConnection = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onConfigureConnection })

    await screen.findByRole('heading', { name: 'DSH connection' })
    fireEvent.click(screen.getByRole('radio', { name: /Custom endpoint/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply and reconnect' }))

    expect(onConfigureConnection).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a local DSH endpoint first.')
  })

  it('shows the upstream DSH version picker and installs the selected exact version', async () => {
    const dshUpdate: DshUpdateSnapshot = {
      status: 'ready',
      currentVersion: '0.1.0-rc.6',
      currentSource: 'npm-global',
      globalVersion: '0.1.0-rc.6',
      latestVersion: '0.1.0-rc.8',
      latestTagVersion: '0.1.0-rc.7',
      nextTagVersion: '0.1.0-rc.8',
      availableVersions: ['0.1.0-rc.8', '0.1.0-rc.7', '0.1.0-rc.6'],
      updateAvailable: true,
      checkedAt: '2026-08-21T00:00:00.000Z',
    }
    const onCheckDshUpdates = vi.fn().mockResolvedValue(dshUpdate)
    const onInstallDshVersion = vi.fn().mockResolvedValue(dshUpdate)
    renderDrawer({ dshUpdate, onCheckDshUpdates, onInstallDshVersion })

    expect(await screen.findByText('An upstream update is available: 0.1.0-rc.8.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(onCheckDshUpdates).toHaveBeenCalledWith(true))
    fireEvent.change(screen.getByLabelText('Version to install'), { target: { value: '0.1.0-rc.7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Download and install' }))
    await waitFor(() => expect(onInstallDshVersion).toHaveBeenCalledWith('0.1.0-rc.7'))
  })

  it('shows the Host-side npm failure reason instead of hiding it behind a generic warning', async () => {
    const dshUpdate: DshUpdateSnapshot = {
      status: 'unavailable',
      availableVersions: [],
      updateAvailable: false,
      checkedAt: '2026-08-21T00:00:00.000Z',
      failure: 'npm-not-found',
    }
    renderDrawer({
      dshUpdate,
      onCheckDshUpdates: vi.fn().mockResolvedValue(dshUpdate),
      onInstallDshVersion: vi.fn().mockResolvedValue(dshUpdate),
    })

    expect(await screen.findByText(/Extension Host could not start npm/i)).toBeDefined()
  })

  it('opens the host-owned settings document when the host advertises one', async () => {
    const onOpenDshSettingsDocument = vi.fn().mockResolvedValue(undefined)
    const fixture = dshSettingsFixture()
    renderDrawer({
      onOpenDshSettingsDocument,
      onLoadDshSettings: vi.fn().mockResolvedValue({
        ...fixture,
        schema: { ...fixture.schema, hasDocument: true },
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings file' }))
    await waitFor(() => expect(onOpenDshSettingsDocument).toHaveBeenCalledTimes(1))
  })

  it('does not report a connected host as disconnected when its version is unavailable', async () => {
    renderDrawer({ connected: true, connectedDshVersion: undefined })
    await waitFor(() => expect(screen.getByText(/version unavailable/i)).toBeDefined())
    expect(screen.queryByText('not connected')).toBeNull()
  })

  it('renders the official General rows only for schema-advertised enum fields', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByRole('group', { name: 'Permission' })).toBeDefined())
    expect(screen.getByRole('group', { name: 'Language' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Composer Enter' })).toBeDefined()
    // Non-enum and non-General fields never gain a fabricated control.
    expect(screen.queryByRole('group', { name: 'timeoutMs' })).toBeNull()
    // The current permission value renders as the pressed segment.
    expect(screen.getByRole('button', { name: 'Workspace Write', pressed: true })).toBeDefined()
  })

  it('writes a picked value through the settings update channel and reloads', async () => {
    const fixture = dshSettingsFixture()
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    const onLoadDshSettings = vi.fn().mockResolvedValue(fixture)
    renderDrawer({ onUpdateDshSetting, onLoadDshSettings })
    await waitFor(() => expect(screen.getByRole('group', { name: 'Appearance' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'dark' }))
    await waitFor(() => expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-theme.preference', 'dark'))
    // A successful write reloads the authoritative snapshot.
    await waitFor(() => expect(onLoadDshSettings).toHaveBeenCalledTimes(2))
  })

  it('requires an explicit confirmation before saving full access', async () => {
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onUpdateDshSetting })
    await waitFor(() => expect(screen.getByRole('group', { name: 'Permission' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Full Access' }))
    expect(onUpdateDshSetting).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm full access' })
    expect(dialog).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog', { name: 'Confirm full access' })).toBeNull()
    expect(onUpdateDshSetting).not.toHaveBeenCalled()
  })

  it('saves full access after the explicit confirmation', async () => {
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onUpdateDshSetting })
    await waitFor(() => expect(screen.getByRole('group', { name: 'Permission' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Full Access' }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm full access' })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm full access' }))
    await waitFor(() =>
      expect(onUpdateDshSetting).toHaveBeenCalledWith('permission.defaultPreset', 'danger-full-access'),
    )
  })

  it('disables every General write control for a read-only settings provider', async () => {
    const fixture = dshSettingsFixture()
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({
      onLoadDshSettings: vi.fn().mockResolvedValue({
        ...fixture,
        schema: { ...fixture.schema, writable: false },
      }),
      onUpdateDshSetting,
    })

    expect(await screen.findByText(/settings provider is read-only/i)).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'dark' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'dark' }))
    expect(onUpdateDshSetting).not.toHaveBeenCalled()
  })

  it('surfaces a write failure and reloads the authoritative values', async () => {
    const failure = new Error('settings-conflict')
    const fixture = dshSettingsFixture()
    const onUpdateDshSetting = vi.fn().mockRejectedValue(failure)
    const onLoadDshSettings = vi.fn().mockResolvedValue(fixture)
    renderDrawer({ onUpdateDshSetting, onLoadDshSettings })
    await waitFor(() => expect(screen.getByRole('group', { name: 'Composer Enter' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'steer' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('settings-conflict'))
    await waitFor(() => expect(onLoadDshSettings).toHaveBeenCalledTimes(2))
  })

  it('degrades to an explicit note when the host settings cannot be read', async () => {
    renderDrawer({ onLoadDshSettings: vi.fn().mockResolvedValue(undefined) })
    await waitFor(() => expect(screen.getByText(/DSH preferences are unavailable/)).toBeDefined())
    expect(screen.queryByRole('group', { name: 'Permission' })).toBeNull()
  })

  it('switches to the models tab and lists providers with secret state', async () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(await screen.findByText('DeepSeek')).toBeDefined()
    expect(await screen.findByText('Missing')).toBeDefined()
    expect(screen.queryByText('Configured')).toBeNull()
    expect(await screen.findByText('1 provider · 2 models')).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Configure' })).toBeDefined()
  })

  it('matches the official provider join: configured rows stay visible, dormant catalog rows stay hidden', async () => {
    const deepseek: ModelProvider = {
      ...baseProvider,
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    }
    const minimax: ModelProvider = {
      ...baseProvider,
      id: 'minimax-cn',
      name: 'minimax-cn',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'minimax-cn'],
      fields: [],
    }
    const dormant: ModelProvider = {
      ...baseProvider,
      id: 'amazon-bedrock',
      name: 'amazon-bedrock',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'amazon-bedrock'],
      fields: [],
    }
    const snapshot: DshSettingsSnapshot = {
      ...dshSettingsFixture(),
      values: {
        'llm-deepseek': {},
        'llm-pi-ai': { providers: { 'minimax-cn': { models: [{ id: 'MiniMax-M1' }] } } },
      },
    }
    renderDrawer({
      providers: [deepseek, minimax, dormant],
      onLoadDshSettings: vi.fn().mockResolvedValue(snapshot),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    await waitFor(() => expect(screen.getByText('2 providers · 2 models')).toBeDefined())
    expect(screen.getByText('DeepSeek')).toBeDefined()
    expect(screen.getByText('minimax-cn')).toBeDefined()
    expect(screen.queryByText('amazon-bedrock')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2)
  })

  it('does not render the provider directory before the settings join is ready', () => {
    const dormant: ModelProvider = {
      ...baseProvider,
      id: 'amazon-bedrock',
      name: 'amazon-bedrock',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'amazon-bedrock'],
    }
    renderDrawer({
      providers: [dormant],
      onLoadDshSettings: vi.fn(() => new Promise<DshSettingsSnapshot>(() => undefined)),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(screen.getByText(/Loading DSH settings/)).toBeDefined()
    expect(screen.queryByText('amazon-bedrock')).toBeNull()
  })

  it('configures a secret and refreshes the catalog afterwards', async () => {
    const onConfigureSecret = vi.fn().mockResolvedValue(true)
    const onRefreshCatalog = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onConfigureSecret, onRefreshCatalog })
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }))
    await waitFor(() => expect(onConfigureSecret).toHaveBeenCalledWith('deepseek', 'apiKeyEnv'))
    await waitFor(() => expect(onRefreshCatalog).toHaveBeenCalled())
  })

  it('edits a schema-advertised model list and imports discovered models', async () => {
    const provider: ModelProvider = {
      ...baseProvider,
      id: 'openai',
      name: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }
    const fixture = dshSettingsFixture()
    const snapshot: DshSettingsSnapshot = {
      ...fixture,
      schema: {
        ...fixture.schema,
        fields: [
          ...fixture.schema.fields,
          {
            path: 'llm-pi-ai.providers.openai.models',
            label: 'models',
            type: 'array',
            required: false,
            restartRequired: false,
          },
        ],
      },
      values: {
        ...fixture.values,
        'llm-pi-ai': {
          providers: {
            openai: {
              models: [{ id: 'local-chat', name: 'Local Chat' }],
            },
          },
        },
      },
    }
    const onDiscoverModels = vi
      .fn()
      .mockResolvedValue([{ id: 'remote-chat', label: 'Remote Chat', contextWindow: 64_000 }])
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({
      providers: [provider],
      onDiscoverModels,
      onUpdateDshSetting,
      onLoadDshSettings: vi.fn().mockResolvedValue(snapshot),
    })
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getAllByRole('region', { name: 'Configured model list' })[0]!
    expect(editor).toBeDefined()
    fireEvent.click(within(editor).getByRole('button', { name: 'Get available models' }))
    await waitFor(() =>
      expect(onDiscoverModels).toHaveBeenCalledWith({
        settingsNamespace: 'llm-pi-ai',
        providerId: 'openai',
        baseUrl: 'https://api.deepseek.com',
      }),
    )
    const picker = await screen.findByRole('dialog', { name: 'Available models' })
    fireEvent.click(within(picker).getByRole('button', { name: 'Add selected' }))
    expect(
      screen.getAllByRole('textbox').some((input) => (input as HTMLInputElement).value === 'remote-chat'),
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(onUpdateDshSetting).toHaveBeenCalledWith('llm-pi-ai.providers.openai.models', [
        { id: 'local-chat', name: 'Local Chat' },
        { id: 'remote-chat', name: 'Remote Chat', contextWindow: 64_000 },
      ]),
    )
  })

  it('offers a dashed custom-provider card from a dynamic settings path', async () => {
    const provider: ModelProvider = {
      ...baseProvider,
      id: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }
    const fixture = dshSettingsFixture()
    const snapshot: DshSettingsSnapshot = {
      ...fixture,
      schema: {
        ...fixture.schema,
        fields: [
          ...fixture.schema.fields,
          {
            path: 'llm-pi-ai.providers.openai.models',
            label: 'models',
            type: 'array',
            required: false,
            restartRequired: false,
          },
        ],
      },
      values: {
        ...fixture.values,
        'llm-pi-ai': { providers: { openai: { api: 'openai-completions', models: [] } } },
      },
    }
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({
      providers: [provider],
      onUpdateDshSetting,
      onLoadDshSettings: vi.fn().mockResolvedValue(snapshot),
    })
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add custom provider' }))
    const card = screen.getByRole('region', { name: 'Add custom provider' })
    fireEvent.change(within(card).getByRole('textbox', { name: 'Provider ID' }), {
      target: { value: 'gateway' },
    })
    fireEvent.change(within(card).getByRole('textbox', { name: 'Provider base URL' }), {
      target: { value: 'http://127.0.0.1:9000/v1' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Add model' }))
    fireEvent.change(within(card).getAllByRole('textbox')[4]!, { target: { value: 'gateway-chat' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save provider' }))
    await waitFor(() =>
      expect(onUpdateDshSetting).toHaveBeenCalledWith(
        'llm-pi-ai.providers.gateway',
        expect.objectContaining({
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9000/v1',
          models: [{ id: 'gateway-chat' }],
        }),
      ),
    )
  })

  it('exposes secret removal only for configured fields', async () => {
    const configured: readonly ModelProvider[] = [
      {
        ...baseProvider,
        fields: [
          {
            key: 'apiKeyEnv',
            label: 'API key',
            secret: true,
            required: true,
            writable: true,
            value: '[configured]',
          },
        ],
      },
    ]
    renderDrawer({ providers: configured })
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(await screen.findByText('Configured')).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Replace' })).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Remove DeepSeek API key' })).toBeDefined()
  })

  it('keeps an environment-shadowed credential visible but disables replacement and removal', async () => {
    const configured: readonly ModelProvider[] = [
      {
        ...baseProvider,
        fields: [
          {
            key: 'apiKeyEnv',
            label: 'API key',
            secret: true,
            required: true,
            writable: false,
            value: '[configured]',
          },
        ],
      },
    ]
    renderDrawer({ providers: configured })
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))

    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Replace' })).disabled).toBe(true)
    expect(
      (await screen.findByRole<HTMLButtonElement>('button', { name: 'Remove DeepSeek API key' })).disabled,
    ).toBe(true)
  })

  it('switches to the plugins tab and reads the read-only inventory', async () => {
    const onLoadPluginInventory = vi.fn().mockResolvedValue({
      entries: [
        {
          entryId: 'ui-settings',
          moduleName: '@deepseek-ai/dsh-client-ui-settings',
          enabled: true,
          fiberPhase: 'active',
        },
      ],
    })
    renderDrawer({ onLoadPluginInventory })
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    await waitFor(() => expect(onLoadPluginInventory).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('ui-settings')).toBeDefined())
  })

  it('closes on Escape', () => {
    const onOpenChange = vi.fn()
    renderDrawer({ onOpenChange })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders nothing when closed', () => {
    renderDrawer({ open: false })
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })
})
