// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionSettingsSummary, ModelDescriptor, ModelProvider } from '@dsh-vscode/domain'
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
    connection: { mode: 'new-isolated' },
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
      providers={providers}
      models={models}
      onLoadSettings={vi.fn().mockResolvedValue(settingsFixture())}
      onLoadDshSettings={vi.fn().mockResolvedValue(dshSettingsFixture())}
      onUpdateDshSetting={vi.fn().mockResolvedValue(undefined)}
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

  it('switches to the models tab and lists providers with secret state', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(screen.getByText('DeepSeek')).toBeDefined()
    expect(screen.getByText('Missing')).toBeDefined()
    expect(screen.queryByText('Configured')).toBeNull()
    expect(screen.getByText('1 provider · 2 models')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Configure' })).toBeDefined()
  })

  it('configures a secret and refreshes the catalog afterwards', async () => {
    const onConfigureSecret = vi.fn().mockResolvedValue(true)
    const onRefreshCatalog = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onConfigureSecret, onRefreshCatalog })
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }))
    await waitFor(() => expect(onConfigureSecret).toHaveBeenCalledWith('deepseek', 'apiKeyEnv'))
    await waitFor(() => expect(onRefreshCatalog).toHaveBeenCalled())
  })

  it('exposes secret removal only for configured fields', () => {
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
    expect(screen.getByText('Configured')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove DeepSeek API key' })).toBeDefined()
  })

  it('keeps an environment-shadowed credential visible but disables replacement and removal', () => {
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

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Replace' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove DeepSeek API key' }).disabled).toBe(
      true,
    )
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
