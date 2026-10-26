// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionSettingsSummary, ModelDescriptor, ModelProvider } from '@dsh-vscode/domain'

import { type DshSettingsSnapshot } from '../../app/store.js'
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
    extensionVersion: '0.1.3',
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
        { ns: 'permission', applies: 'live', revision: 1, userFields: ['defaultPreset'], secrets: [] },
        { ns: 'shell', applies: 'restart', revision: 2, userFields: ['timeoutMs'], secrets: [] },
        { ns: 'ui-theme', applies: 'live', revision: 3, userFields: ['preference'], secrets: [] },
        { ns: 'ui-chat', applies: 'live', revision: 4, userFields: [], secrets: [] },
        { ns: 'ui-settings', applies: 'live', revision: 5, userFields: ['enabled'], secrets: [] },
        { ns: 'agent-presets', applies: 'live', revision: 6, userFields: ['default'], secrets: [] },
        { ns: 'llm-pi-ai', applies: 'live', revision: 7, userFields: [], secrets: [] },
        { ns: 'ui-conversation', applies: 'live', revision: 8, userFields: ['busyEnter'], secrets: [] },
        { ns: 'locale', applies: 'live', revision: 9, userFields: [], secrets: [] },
        { ns: 'agent-preset-registry', applies: 'live', revision: 10, userFields: [], secrets: [] },
      ],
    },
    values: {
      permission: { defaultPreset: 'workspace-write' },
      'ui-conversation': { busyEnter: 'queue' },
    },
  }
}

function drawerElement(
  overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {},
  localized = false,
): ReactElement {
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
      onOpenKeyboardShortcuts={vi.fn().mockResolvedValue(undefined)}
      onUpdateDshSetting={vi.fn().mockResolvedValue(undefined)}
      onUnsetDshSetting={vi.fn().mockResolvedValue(undefined)}
      onMutateDshSettings={vi.fn().mockResolvedValue(undefined)}
      onCreateCustomProvider={vi.fn().mockResolvedValue({
        profileCommitted: true,
        credentialConfigured: false,
      })}
      theme="system"
      onThemeChange={vi.fn()}
      locale="en"
      onLocaleChange={vi.fn()}
      onLocaleFromDsh={vi.fn()}
      conversationFontSize="medium"
      onConversationFontSizeChange={vi.fn()}
      onDiscoverModels={vi.fn().mockResolvedValue([])}
      onDiscoverCustomModels={vi.fn().mockResolvedValue([])}
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
  return localized ? <I18nProvider>{drawer}</I18nProvider> : drawer
}

function renderDrawer(
  overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {},
  localized = false,
): ReturnType<typeof render> {
  return render(drawerElement(overrides, localized))
}

describe('SettingsDrawer', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    document.documentElement.lang = 'en'
    vi.unstubAllGlobals()
  })

  it('does not preselect a connection mode the page cannot represent and blocks Apply until one is chosen', async () => {
    const onConfigureConnection = vi.fn().mockResolvedValue(undefined)
    renderDrawer({
      onConfigureConnection,
      onLoadSettings: vi.fn().mockResolvedValue({
        ...settingsFixture(),
        connection: { mode: 'attach-only', customEndpointConfigured: false },
      }),
    })

    await screen.findByRole('heading', { name: 'DSH connection' })
    const automatic = screen.getByRole('radio', { name: /Automatic/ })
    const custom = screen.getByRole('radio', { name: /Custom connection/ })
    expect(automatic).toHaveProperty('checked', false)
    expect(custom).toHaveProperty('checked', false)
    expect(screen.getByText(/is managed in VS Code settings/)).toBeDefined()

    const apply = screen.getByRole('button', { name: 'Apply and reconnect' })
    expect(apply).toHaveProperty('disabled', true)
    fireEvent.click(apply)
    expect(onConfigureConnection).not.toHaveBeenCalled()

    fireEvent.click(automatic)
    expect(screen.getByRole('button', { name: 'Apply and reconnect' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Apply and reconnect' }))
    await waitFor(() => expect(onConfigureConnection).toHaveBeenCalledWith('auto', undefined))
  })

  it('requires acknowledgement after cancelling and reopening full access', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Full Access' }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm full access' })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(onUpdateDshSetting).toHaveBeenCalledWith('permission.defaultPreset', 'danger-full-access', 1),
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

    expect(await screen.findByText(/DSH settings are read-only/i)).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'dark' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'dark' }))
    expect(onUpdateDshSetting).not.toHaveBeenCalled()
  })

  it('matches the official provider join: configured rows stay visible, dormant catalog rows stay hidden until added', async () => {
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

  it('retries only the credential after a committed custom profile reports a key failure', async () => {
    const provider: ModelProvider = {
      ...baseProvider,
      id: 'openai',
      fields: [
        ...baseProvider.fields,
        {
          key: 'api',
          label: 'API protocol',
          secret: false,
          required: true,
          enumValues: ['openai-completions'],
          value: 'openai-completions',
        },
      ],
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }
    const onCreateCustomProvider = vi.fn().mockResolvedValue({
      profileCommitted: true,
      credentialConfigured: false,
      credentialError: 'The API key could not be stored. Try again from the provider row.',
    })
    const onConfigureSecret = vi.fn().mockResolvedValue(true)
    renderDrawer({ providers: [provider], onCreateCustomProvider, onConfigureSecret })
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
    fireEvent.change(within(card).getByRole('textbox', { name: 'Model ID' }), {
      target: { value: 'gateway-chat' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save provider' }))

    await waitFor(() => expect(onCreateCustomProvider).toHaveBeenCalledOnce())
    expect(within(card).getByRole('button', { name: 'Configure API key again' })).toBeDefined()
    fireEvent.click(within(card).getByRole('button', { name: 'Configure API key again' }))

    await waitFor(() => expect(onConfigureSecret).toHaveBeenCalledWith('gateway', 'apiKeyEnv'))
    expect(onCreateCustomProvider).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add custom provider' })).toBeNull())
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
})
