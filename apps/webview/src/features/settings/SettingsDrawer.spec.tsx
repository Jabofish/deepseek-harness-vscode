// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
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
        { ns: 'llm-pi-ai', applies: 'live', revision: 7, userFields: [], secrets: [] },
      ],
    },
    values: {
      permission: { defaultPreset: 'workspace-write' },
      'ui-conversation': { busyEnter: 'queue' },
    },
  }
}

function rc2GeneralSettingsFixture(
  options: { writable?: boolean; values?: DshSettingsSnapshot['values'] } = {},
): DshSettingsSnapshot {
  const base = dshSettingsFixture()
  return {
    schema: {
      ...base.schema,
      version: 'rc2-settings-v1',
      writable: options.writable ?? true,
      fields: [
        ...base.schema.fields,
        {
          path: 'ui-chat.transcriptView',
          label: 'transcriptView',
          type: 'enum',
          required: false,
          enumValues: ['compact', 'standard', 'detailed', 'verbose'],
          restartRequired: false,
        },
        {
          path: 'ui-chat.performanceUsage',
          label: 'performanceUsage',
          type: 'enum',
          required: false,
          enumValues: ['compact', 'detailed'],
          restartRequired: false,
        },
        {
          path: 'ui-settings.enabled',
          label: 'enabled',
          type: 'boolean',
          required: false,
          restartRequired: false,
        },
        {
          path: 'ui-theme.fontSize',
          label: 'fontSize',
          type: 'number',
          required: false,
          restartRequired: false,
        },
      ],
    },
    values: options.values ?? {
      ...base.values,
      'ui-theme': { preference: 'system', fontSize: 14 },
      'ui-settings': { enabled: true },
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
  })

  it('opens VS Code keyboard shortcuts from General settings', async () => {
    const onOpenKeyboardShortcuts = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onOpenKeyboardShortcuts })

    fireEvent.click(await screen.findByRole('button', { name: 'Open keyboard shortcuts' }))

    await waitFor(() => expect(onOpenKeyboardShortcuts).toHaveBeenCalledOnce())
  })

  it('mounts account controls only when the selected Host advertises the capability', async () => {
    renderDrawer()
    expect(screen.queryByRole('heading', { name: 'DSH account' })).toBeNull()
    cleanup()

    renderDrawer({ accountLifecycleAvailable: true })
    expect(await screen.findByRole('heading', { name: 'DSH account' })).toBeDefined()
  })

  it('localizes general and model settings when Chinese is selected', async () => {
    window.localStorage.setItem('dsh-webview-locale', 'zh')
    renderDrawer({}, true)

    expect(await screen.findByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '常规' })).toBeDefined()
    expect(screen.getByText('连接模式')).toBeDefined()
    expect(screen.getByRole('group', { name: '界面语言' })).toBeDefined()
    expect(screen.getByRole('button', { name: '中文' })).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: '模型' }))
    expect(screen.getByText('1 个 Provider · 2 个模型')).toBeDefined()
    expect(screen.getByText('缺失')).toBeDefined()
    expect(screen.getByRole('button', { name: '配置' })).toBeDefined()
  })

  it('keeps a live-only provider visible when DSH reports no settings namespace', async () => {
    renderDrawer({
      providers: [
        {
          id: 'runtime-only',
          name: 'Runtime only',
          kind: 'provider',
          configurable: true,
          active: true,
          settingsNs: '',
          settingsPath: [],
          fields: [],
        },
      ],
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Models' }))
    expect(await screen.findByText('Runtime only')).toBeDefined()
    expect(screen.getByText('1 provider · 2 models')).toBeDefined()
    expect(screen.queryByText('No providers reported by DSH.')).toBeNull()
  })

  it('loads and renders general settings facts', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    expect(screen.getByText('0.1.3')).toBeDefined()
    expect(screen.getByText('0.6.0')).toBeDefined()
    expect(screen.getByText('deepseek/deepseek-chat')).toBeDefined()
  })

  it('offers local conversation font size presets', async () => {
    const onConversationFontSizeChange = vi.fn()
    renderDrawer({ onConversationFontSizeChange })

    const group = await screen.findByRole('group', { name: 'Conversation font size' })
    expect(group).toBeDefined()
    expect(screen.getByRole('button', { name: 'Medium', pressed: true })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Large' }))
    expect(onConversationFontSizeChange).toHaveBeenCalledWith('large')
  })

  it('changes the extension language even when DSH settings are unavailable', async () => {
    const onLocaleChange = vi.fn()
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({
      onLocaleChange,
      onUpdateDshSetting,
      onLoadDshSettings: vi.fn().mockResolvedValue(undefined),
    })

    const group = await screen.findByRole('group', { name: 'Interface language' })
    fireEvent.click(within(group).getByRole('button', { name: '中文' }))

    expect(onLocaleChange).toHaveBeenCalledWith('zh')
    expect(onUpdateDshSetting).not.toHaveBeenCalled()
  })

  it('adopts the authoritative DSH language when settings are loaded', async () => {
    const onLocaleFromDsh = vi.fn()
    const fixture = dshSettingsFixture()
    renderDrawer({
      onLocaleFromDsh,
      onLoadDshSettings: vi.fn().mockResolvedValue({
        ...fixture,
        values: { ...fixture.values, locale: { preference: 'zh' } },
      }),
    })

    await waitFor(() => expect(onLocaleFromDsh).toHaveBeenCalledWith('zh'))
  })

  it('applies the appearance choice locally while updating the DSH preference', async () => {
    const onThemeChange = vi.fn()
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onThemeChange, onUpdateDshSetting })

    await waitFor(() => expect(screen.getByRole('group', { name: 'Appearance' })).toBeDefined())
    expect(screen.getByRole('button', { name: 'system', pressed: true })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'light' }))

    expect(onThemeChange).toHaveBeenCalledWith('light')
    await waitFor(() => expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-theme.preference', 'light'))
  })

  it('keeps general settings sections in a predictable order', async () => {
    renderDrawer({
      onCheckDshUpdates: vi.fn().mockResolvedValue(undefined),
      onInstallDshVersion: vi.fn().mockResolvedValue(undefined),
    })

    const panel = await screen.findByRole('tabpanel')
    const connection = await within(panel).findByRole('region', { name: 'DSH connection' })
    const updates = within(panel).getByRole('region', { name: 'DSH updates' })
    const extensionPreferences = within(panel).getByRole('region', { name: 'Extension preferences' })
    const preferences = within(panel).getByRole('region', { name: 'DSH preferences' })
    const appearance = within(panel).getByRole('region', { name: 'Conversation appearance' })
    const position = (element: Element): number => Array.from(panel.children).indexOf(element)

    expect(position(connection)).toBeLessThan(position(updates))
    expect(position(updates)).toBeLessThan(position(extensionPreferences))
    expect(position(extensionPreferences)).toBeLessThan(position(preferences))
    expect(position(preferences)).toBeLessThan(position(appearance))
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
    fireEvent.click(screen.getByRole('button', { name: /Version to install: 0\.1\.0-rc\.8/u }))
    fireEvent.click(screen.getByRole('option', { name: '0.1.0-rc.7' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download and install' }))
    await waitFor(() => expect(onInstallDshVersion).toHaveBeenCalledWith('0.1.0-rc.7'))
  })

  it('does not offer a redundant install when the selected version is already global', async () => {
    const dshUpdate: DshUpdateSnapshot = {
      status: 'ready',
      currentVersion: '0.1.0-rc.8',
      currentSource: 'npm-global',
      globalVersion: '0.1.0-rc.8',
      latestVersion: '0.1.0-rc.8',
      availableVersions: ['0.1.0-rc.8', '0.1.0-rc.7'],
      updateAvailable: false,
      checkedAt: '2026-08-21T00:00:00.000Z',
    }
    const onInstallDshVersion = vi.fn().mockResolvedValue(dshUpdate)
    renderDrawer({
      dshUpdate,
      onCheckDshUpdates: vi.fn().mockResolvedValue(dshUpdate),
      onInstallDshVersion,
    })

    expect(await screen.findByText('Version 0.1.0-rc.8 is already installed.')).toBeDefined()
    const installButton = screen.getByRole('button', { name: 'Already installed' })
    expect((installButton as HTMLButtonElement).disabled).toBe(true)
    expect(onInstallDshVersion).not.toHaveBeenCalled()
  })

  it('shows a determinate lifecycle stage while installation is pending', async () => {
    const dshUpdate: DshUpdateSnapshot = {
      status: 'ready',
      currentVersion: '0.1.0-rc.6',
      currentSource: 'npm-global',
      globalVersion: '0.1.0-rc.6',
      latestVersion: '0.1.0-rc.8',
      availableVersions: ['0.1.0-rc.8', '0.1.0-rc.7', '0.1.0-rc.6'],
      updateAvailable: true,
      checkedAt: '2026-08-21T00:00:00.000Z',
    }
    let resolveInstall: ((snapshot: DshUpdateSnapshot) => void) | undefined
    const onInstallDshVersion = vi.fn(
      () =>
        new Promise<DshUpdateSnapshot>((resolve) => {
          resolveInstall = resolve
        }),
    )
    renderDrawer({
      dshUpdate,
      dshUpdateProgress: { phase: 'downloading', version: '0.1.0-rc.8' },
      onCheckDshUpdates: vi.fn().mockResolvedValue(dshUpdate),
      onInstallDshVersion,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Download and install' }))
    const progress = await screen.findByRole('progressbar', { name: 'DSH update progress' })
    expect(progress.getAttribute('aria-valuenow')).toBe('2')
    expect(screen.getByText('Stage 2/4')).toBeDefined()

    resolveInstall?.(dshUpdate)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Download and install' }).hasAttribute('disabled')).toBe(
        false,
      ),
    )
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
    expect(screen.getByRole('group', { name: 'Interface language' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Composer Enter' })).toBeDefined()
    // Non-enum and non-General fields never gain a fabricated control.
    expect(screen.queryByRole('group', { name: 'timeoutMs' })).toBeNull()
    // The current permission value renders as the pressed segment.
    expect(screen.getByRole('button', { name: 'Workspace Write', pressed: true })).toBeDefined()
  })

  it('renders the rc2 General preferences with their upstream defaults', async () => {
    renderDrawer({ onLoadDshSettings: vi.fn().mockResolvedValue(rc2GeneralSettingsFixture({ values: {} })) })

    const transcript = await screen.findByRole('group', { name: 'Workflow display' })
    const performance = screen.getByRole('group', { name: 'Performance and usage' })
    expect(within(transcript).getByRole('button', { name: 'Standard', pressed: true })).toBeDefined()
    expect(within(performance).getByRole('button', { name: 'Detailed', pressed: true })).toBeDefined()
    expect(screen.getByRole('switch', { name: 'Developer Tools', checked: true })).toBeDefined()
    expect(screen.getByRole('spinbutton', { name: 'Conversation font size' })).toHaveProperty('value', '14')
  })

  it('writes transcript, usage, coding-tools, and font-size choices through the Host settings channel', async () => {
    const initial = rc2GeneralSettingsFixture()
    const onLoadDshSettings = vi.fn().mockResolvedValue(initial)
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onLoadDshSettings, onUpdateDshSetting })

    const transcript = await screen.findByRole('group', { name: 'Workflow display' })
    fireEvent.click(within(transcript).getByRole('button', { name: 'Compact' }))
    await waitFor(() => expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-chat.transcriptView', 'compact'))
    await waitFor(() => expect(onLoadDshSettings).toHaveBeenCalledTimes(2))

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Performance and usage' })).getByRole('button', {
        name: 'Compact',
      }),
    )
    await waitFor(() =>
      expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-chat.performanceUsage', 'compact'),
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Developer Tools' }))
    await waitFor(() => expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-settings.enabled', false))
    const fontSize = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Conversation font size' })
    fireEvent.change(fontSize, { target: { value: '16' } })
    fireEvent.blur(fontSize)
    await waitFor(() => expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-theme.fontSize', 16))
  })

  it('does not invent rc2 controls for an older schema and keeps the local font fallback', async () => {
    renderDrawer({ onLoadDshSettings: vi.fn().mockResolvedValue(dshSettingsFixture()) })

    await screen.findByRole('group', { name: 'Appearance' })
    expect(screen.queryByRole('group', { name: 'Workflow display' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Performance and usage' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Developer Tools' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Conversation font size' })).toBeDefined()
  })

  it('hides new controls when the rc2 settings schema is read-only', async () => {
    renderDrawer({
      onLoadDshSettings: vi.fn().mockResolvedValue(rc2GeneralSettingsFixture({ writable: false })),
    })

    await waitFor(() => expect(screen.getByText(/settings provider is read-only/i)).toBeDefined())
    expect(screen.queryByRole('group', { name: 'Workflow display' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Performance and usage' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Developer Tools' })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: 'Conversation font size' })).toBeNull()
  })

  it('keeps rc2 controls unavailable while the settings snapshot is loading or fails', async () => {
    let resolveSettings: ((snapshot: DshSettingsSnapshot) => void) | undefined
    const pendingSettings = new Promise<DshSettingsSnapshot>((resolve) => {
      resolveSettings = resolve
    })
    renderDrawer({ onLoadDshSettings: vi.fn().mockReturnValue(pendingSettings) })
    expect(screen.getByText(/loading DSH settings/i)).toBeDefined()
    expect(screen.queryByRole('switch', { name: 'Developer Tools' })).toBeNull()
    act(() => resolveSettings?.(rc2GeneralSettingsFixture()))
    expect(await screen.findByRole('switch', { name: 'Developer Tools' })).toBeDefined()

    cleanup()
    renderDrawer({ onLoadDshSettings: vi.fn().mockRejectedValue(new Error('offline')) })
    expect(await screen.findByText(/DSH preferences are unavailable/)).toBeDefined()
    expect(screen.queryByRole('group', { name: 'Workflow display' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Developer Tools' })).toBeNull()
  })

  it('keeps an rc2 preference unchanged after a failed Host update', async () => {
    const onUpdateDshSetting = vi.fn().mockRejectedValue(new Error('settings-conflict'))
    renderDrawer({
      onLoadDshSettings: vi.fn().mockResolvedValue(rc2GeneralSettingsFixture()),
      onUpdateDshSetting,
    })

    const developerTools = await screen.findByRole('switch', { name: 'Developer Tools' })
    fireEvent.click(developerTools)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('settings-conflict'))
    expect(screen.getByRole('switch', { name: 'Developer Tools', checked: true })).toBeDefined()
    expect(onUpdateDshSetting).toHaveBeenCalledWith('ui-settings.enabled', false)
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

  it('restores separate catalog-provider and custom-provider add actions', async () => {
    const wholeSection: ModelProvider = {
      ...baseProvider,
      id: 'deepseek-official',
      name: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      fields: [],
    }
    const dormant: ModelProvider = {
      ...baseProvider,
      id: 'amazon-bedrock',
      name: 'Amazon Bedrock',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'amazon-bedrock'],
      fields: [],
    }
    const secondDormant: ModelProvider = {
      ...dormant,
      id: 'openai',
      name: 'OpenAI',
      settingsPath: ['providers', 'openai'],
      fields: [
        {
          key: 'api',
          label: 'API protocol',
          secret: false,
          required: true,
          enumValues: ['openai-completions', 'anthropic-messages'],
          value: 'openai-completions',
        },
      ],
    }
    const snapshot: DshSettingsSnapshot = {
      ...dshSettingsFixture(),
      values: { ...dshSettingsFixture().values, 'llm-pi-ai': { providers: {} } },
    }
    const onUpdateDshSetting = vi.fn().mockResolvedValue(undefined)
    renderDrawer({
      providers: [baseProvider, wholeSection, dormant, secondDormant],
      onUpdateDshSetting,
      onLoadDshSettings: vi.fn().mockResolvedValue(snapshot),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    const addProvider = await screen.findByRole('button', { name: 'Add provider' })
    expect((addProvider as HTMLButtonElement).disabled).toBe(false)
    const addCustomProvider = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Add custom provider',
    })
    expect(addCustomProvider.disabled).toBe(false)
    fireEvent.click(addProvider)

    const card = screen.getByRole('region', { name: 'Add provider' })
    const selector = within(card).getByRole('button', { name: 'Provider: DeepSeek' })
    fireEvent.click(selector)
    expect(within(card).getAllByRole('option')).toHaveLength(3)
    fireEvent.click(within(card).getByRole('option', { name: 'OpenAI' }))
    expect(screen.getByRole('button', { name: 'Provider: OpenAI' })).toBeDefined()
    fireEvent.click(within(card).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(onUpdateDshSetting).toHaveBeenCalledWith('llm-pi-ai.providers.openai', {}))

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    const reopenedCard = screen.getByRole('region', { name: 'Add provider' })
    fireEvent.click(within(reopenedCard).getByRole('button', { name: 'Cancel' }))
    expect(onUpdateDshSetting).toHaveBeenCalledTimes(1)
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

  it('lets the user retry DSH settings after the initial read fails', async () => {
    const onLoadDshSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(dshSettingsFixture())
    renderDrawer({ onLoadDshSettings }, true)

    expect(await screen.findByText(/DSH preferences are unavailable/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(onLoadDshSettings).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('group', { name: 'Composer Enter' })).toBeDefined()
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
              models: [{ id: 'local-chat', name: 'Local Chat', inputModalities: ['text', 'image'] }],
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
        { id: 'local-chat', name: 'Local Chat', inputModalities: ['text', 'image'] },
        { id: 'remote-chat', name: 'Remote Chat', contextWindow: 64_000 },
      ]),
    )
  })

  it('offers a dashed custom-provider card from a dynamic settings path', async () => {
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
          enumValues: ['openai-completions', 'anthropic-messages'],
          value: 'openai-completions',
        },
      ],
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
    const onCreateCustomProvider = vi.fn().mockResolvedValue({
      profileCommitted: true,
      credentialConfigured: false,
    })
    renderDrawer({
      providers: [provider],
      onCreateCustomProvider,
      onLoadDshSettings: vi.fn().mockResolvedValue(snapshot),
    })
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add custom provider' }))
    const card = screen.getByRole('region', { name: 'Add custom provider' })
    expect(within(card).queryByRole('combobox')).toBeNull()
    const apiMenu = within(card).getByRole('button', { name: 'API protocol: openai-completions' })
    fireEvent.click(apiMenu)
    expect(within(card).getByRole('listbox', { name: 'API protocol' })).toBeDefined()
    fireEvent.click(within(card).getByRole('option', { name: 'openai-completions' }))
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
    await waitFor(() =>
      expect(onCreateCustomProvider).toHaveBeenCalledWith({
        settingsNamespace: 'llm-pi-ai',
        collectionPath: ['providers'],
        providerId: 'gateway',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: [{ id: 'gateway-chat' }],
        expectedRevision: 7,
      }),
    )
    // A committed create closes the editor by itself; the Close button stays
    // disabled until the save settles, so clicking it here is a race.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add custom provider' })).toBeNull())
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
    expect(within(card).getByRole('button', { name: 'Retry API key' })).toBeDefined()
    fireEvent.click(within(card).getByRole('button', { name: 'Retry API key' }))

    await waitFor(() => expect(onConfigureSecret).toHaveBeenCalledWith('gateway', 'apiKeyEnv'))
    expect(onCreateCustomProvider).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add custom provider' })).toBeNull())
  })

  it('does not repeat a committed custom profile when catalog refresh fails', async () => {
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
    })
    const onRefreshCatalog = vi.fn().mockRejectedValue(new Error('catalog refresh unavailable'))
    renderDrawer({ providers: [provider], onCreateCustomProvider, onRefreshCatalog })
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
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add custom provider' })).toBeNull())
    expect(screen.getByText('catalog refresh unavailable')).toBeDefined()
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

  it('keeps the drawer open when Escape only dismisses a provider dropdown', async () => {
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
          enumValues: ['openai-completions', 'anthropic-messages'],
          value: 'openai-completions',
        },
      ],
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }
    const onOpenChange = vi.fn()
    renderDrawer({ providers: [provider], onOpenChange })
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add custom provider' }))
    const card = screen.getByRole('region', { name: 'Add custom provider' })
    fireEvent.change(within(card).getByRole('textbox', { name: 'Provider ID' }), {
      target: { value: 'gateway' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'API protocol: openai-completions' }))
    expect(within(card).getByRole('listbox', { name: 'API protocol' })).toBeDefined()

    fireEvent.keyDown(within(card).getByRole('option', { name: 'openai-completions' }), {
      key: 'Escape',
    })

    expect(screen.queryByRole('listbox', { name: 'API protocol' })).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    const reopened = screen.getByRole('region', { name: 'Add custom provider' })
    expect(within(reopened).getByRole('textbox', { name: 'Provider ID' })).toHaveProperty('value', 'gateway')
  })

  it('lets a preset modal consume Escape so the drawer underneath stays open', async () => {
    const onOpenChange = vi.fn()
    const onLoadPresetRoster = vi.fn().mockResolvedValue({
      presets: [{ id: 'standard', trust: 'system' as const, isDefault: true, name: 'Standard' }],
      authorable: true,
      hasDocument: true,
    })
    renderDrawer({ onOpenChange, onLoadPresetRoster })
    await waitFor(() => expect(screen.getByText('new-isolated')).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: 'Presets' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy preset: Standard' }))
    expect(screen.getByRole('dialog', { name: 'Copy preset' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })

    // The modal is the innermost layer: one Escape closes it and stops there.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy preset' })).toBeNull())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeDefined()
  })

  it('takes focus into the provider removal confirmation and gives it back to the row', async () => {
    const customProvider: ModelProvider = {
      id: 'my-llm',
      name: 'My LLM',
      kind: 'remote',
      configurable: true,
      settingsNs: 'llm-my-llm',
      settingsPath: ['my-llm'],
      fields: [],
    }
    const fixture = dshSettingsFixture()
    const removable: DshSettingsSnapshot = {
      ...fixture,
      schema: {
        ...fixture.schema,
        namespaces: [
          ...fixture.schema.namespaces,
          { ns: 'llm-my-llm', applies: 'live', revision: 1, userFields: [], secrets: [] },
        ],
      },
      values: { ...fixture.values, 'llm-my-llm': { 'my-llm': { api: 'openai-completions' } } },
    }
    renderDrawer({
      providers: [customProvider],
      models: [],
      onLoadDshSettings: vi.fn().mockResolvedValue(removable),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    const trigger = await screen.findByRole('button', { name: 'Remove' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('alertdialog', { name: 'Remove' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog', { name: 'Remove' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps the keyboard where the user put it while settings load and the host re-renders', async () => {
    let settle: ((value: ExtensionSettingsSummary) => void) | undefined
    const onLoadSettings = vi.fn(
      () =>
        new Promise<ExtensionSettingsSummary>((resolve) => {
          settle = resolve
        }),
    )
    const view = renderDrawer({ onLoadSettings })
    const tab = screen.getByRole('tab', { name: 'Models' })
    tab.focus()
    expect(document.activeElement).toBe(tab)

    // The drawer takes the keyboard once, when it opens. The settings answer
    // lands later and the App keeps re-rendering behind it (a streamed token, a
    // session event, a fresh callback identity) — none of that may move the
    // keyboard the user has since placed on a control of their own choosing.
    await act(async () => {
      settle?.(settingsFixture())
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(tab)

    view.rerender(drawerElement({ onLoadSettings: () => Promise.resolve(settingsFixture()) }))
    expect(document.activeElement).toBe(tab)
  })

  it('renders nothing when closed', () => {
    renderDrawer({ open: false })
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })
})
