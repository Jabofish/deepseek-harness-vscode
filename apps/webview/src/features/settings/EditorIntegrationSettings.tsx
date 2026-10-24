import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { EditorIntegrationPreferences, EditorIntegrationStatus } from '@dsh-vscode/domain'
import { editorIntegrationStatusSchema, type FeatureRequest } from '@dsh-vscode/webview-protocol'
import { SettingCard, SettingRow } from '../../components/common/SettingCard.js'
import { useI18n } from '../../i18n.js'
import type { SettingsDrawerProps } from './settings-drawer-props.js'
import { failureKey } from '../plugins/optional-bundle-model.js'

/** All operations go through the Host. Status polling stops when the settings tab closes. */
export function EditorIntegrationSettings({
  request,
}: {
  readonly request: SettingsDrawerProps['featureRequest']
}): ReactElement {
  const { t } = useI18n()
  const [status, setStatus] = useState<EditorIntegrationStatus>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cancellingRef = useRef(false)
  const epoch = useRef(0)
  const mounted = useRef(false)
  const busyRef = useRef(false)
  useEffect(() => {
    mounted.current = true
    let polling = false
    const refresh = async (): Promise<void> => {
      if (request === undefined || polling) return
      polling = true
      const current = epoch.current
      try {
        const response = editorIntegrationStatusSchema.parse(
          await request<unknown>({
            type: 'editor.companion.status',
            requestId: crypto.randomUUID(),
            payload: {},
          }),
        )
        if (mounted.current && current === epoch.current) {
          setStatus(response)
          setFailed(false)
        }
      } catch {
        if (mounted.current && current === epoch.current) setFailed(true)
      } finally {
        polling = false
      }
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 2_000)
    return () => {
      mounted.current = false
      epoch.current += 1
      clearInterval(timer)
    }
  }, [request])

  const execute = async (command: FeatureRequest): Promise<void> => {
    if (request === undefined || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const setup =
      command.type === 'editor.companion.action' &&
      (command.payload.action === 'setup' || command.payload.action === 'prepare-pnpm')
    if (setup) setInstalling(true)
    const current = ++epoch.current
    try {
      const response = editorIntegrationStatusSchema.parse(await request<unknown>(command))
      if (mounted.current && current === epoch.current) {
        // A status read started during this action must not replace its final result.
        epoch.current += 1
        setStatus(response)
        setFailed(false)
      }
    } catch {
      if (mounted.current && current === epoch.current) setFailed(true)
    } finally {
      busyRef.current = false
      if (mounted.current) {
        setBusy(false)
        if (setup) setInstalling(false)
      }
    }
  }
  const configure = (change: Partial<EditorIntegrationPreferences>): void => {
    void execute({ type: 'editor.companion.configure', requestId: crypto.randomUUID(), payload: change })
  }
  const action = (
    name:
      | 'retry'
      | 'setup'
      | 'restore'
      | 'restart'
      | 'undo'
      | 'start-managed'
      | 'check-dependencies'
      | 'copy-pnpm-command'
      | 'open-pnpm-guide'
      | 'prepare-pnpm',
  ): void => {
    void execute({
      type: 'editor.companion.action',
      requestId: crypto.randomUUID(),
      payload: { action: name },
    })
  }
  const cancelInstall = async (): Promise<void> => {
    if (request === undefined || cancellingRef.current) return
    cancellingRef.current = true
    setCancelling(true)
    const current = epoch.current
    try {
      const response = editorIntegrationStatusSchema.parse(
        await request<unknown>({
          type: 'editor.companion.action',
          requestId: crypto.randomUUID(),
          payload: { action: 'cancel-install' },
        }),
      )
      if (mounted.current && current === epoch.current) {
        setStatus(response)
        setFailed(false)
      }
    } catch {
      if (mounted.current && current === epoch.current) setFailed(true)
    } finally {
      cancellingRef.current = false
      if (mounted.current) setCancelling(false)
    }
  }
  const phase = status?.phase
  const installPhase = status?.installation ?? (installing ? 'installing' : undefined)
  const installLabels = {
    'preparing-dependencies': t('editorIntegration.preparingPnpm'),
    'dependencies-failed': t('editorIntegration.preparePnpmFailed'),
    installing: t('editorIntegration.installing'),
    cancelling: t('editorIntegration.cancellingInstall'),
    unknown: t('editorIntegration.installUnknown'),
    cancelled: t('editorIntegration.installCancelled'),
    failed: t('editorIntegration.installFailed'),
    installed: t('editorIntegration.installed'),
  }
  const phases = {
    off: t('editorIntegration.off'),
    waiting: t('editorIntegration.waiting'),
    connecting: t('editorIntegration.connecting'),
    ready: t('editorIntegration.ready'),
    limited: t('editorIntegration.limited'),
    setup: t('editorIntegration.setup'),
    'needs-restart': t('editorIntegration.needsRestart'),
    error: t('editorIntegration.error'),
  }
  const reasons = {
    disconnected: t('editorIntegration.disconnected'),
    workspace: t('editorIntegration.workspace'),
    untrusted: t('editorIntegration.untrusted'),
    session: t('editorIntegration.session'),
    unsupported: t('editorIntegration.unsupported'),
    missing: t('editorIntegration.missing'),
    busy: t('editorIntegration.inUse'),
    connection: t('editorIntegration.connection'),
    'setup-failed': t('editorIntegration.setupFailed'),
    restart: t('editorIntegration.restartHint'),
  }
  const toggle = (key: keyof EditorIntegrationPreferences, label: string): ReactElement => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={status?.preferences[key] ?? false}
      className="dsh-settings__switch"
      disabled={busy || status === undefined}
      onClick={() => configure({ [key]: !status?.preferences[key] })}
    >
      <span aria-hidden="true" />
    </button>
  )
  return (
    <SettingCard
      className="dsh-editor-integration"
      title={t('editorIntegration.title')}
      description={t('editorIntegration.description')}
      ariaLabel={t('editorIntegration.title')}
    >
      <div role="status" aria-label={t('editorIntegration.title')} aria-live="polite">
        <strong>{phase === undefined ? t('editorIntegration.loading') : phases[phase]}</strong>
        {status?.version === undefined ? null : <span> · {status.version}</span>}
        {phase === 'off' || status?.reason === undefined ? null : <p>{reasons[status.reason]}</p>}
      </div>
      <SettingRow
        title={t('editorIntegration.enabled')}
        description={t('editorIntegration.enabledDescription')}
        control={toggle('enabled', t('editorIntegration.enabled'))}
      />
      <SettingRow
        title={t('editorIntegration.allowEdits')}
        description={t('editorIntegration.allowEditsDescription')}
        control={toggle('allowEdits', t('editorIntegration.allowEdits'))}
      />
      {failed ? <p role="alert">{t('editorIntegration.requestFailed')}</p> : null}
      {status !== undefined &&
      status.packageManager !== 'ready' &&
      (status.installed === false ||
        status.packageManager === 'missing' ||
        status.packageManager === 'broken' ||
        installPhase === 'dependencies-failed') ? (
        <div className="dsh-editor-integration__prerequisites">
          <p role="status">
            {status.packageManager === 'missing'
              ? t('editorIntegration.pnpmMissing')
              : status.packageManager === 'broken'
                ? t('editorIntegration.pnpmBroken')
                : t('editorIntegration.pnpmCheck')}
          </p>
          <>
            <div className="dsh-settings__actions">
              {status.canInstall ? (
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={() => action('prepare-pnpm')}
                >
                  {t('editorIntegration.preparePnpm')}
                </button>
              ) : null}
              <button
                type="button"
                className="dsh-button dsh-button--secondary"
                disabled={busy}
                onClick={() => action('check-dependencies')}
              >
                {t('editorIntegration.checkDependencies')}
              </button>
            </div>
            <details className="dsh-settings__environment">
              <summary>{t('editorIntegration.installDetails')}</summary>
              <p>{t('editorIntegration.prerequisites')}</p>
              <code>npm install --global pnpm@11.19.0</code>
              <p>{t('editorIntegration.pnpmInstructions')}</p>
              <div className="dsh-settings__actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={() => action('copy-pnpm-command')}
                >
                  {t('editorIntegration.copyPnpmCommand')}
                </button>
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={() => action('open-pnpm-guide')}
                >
                  {t('editorIntegration.pnpmGuide')}
                </button>
              </div>
            </details>
          </>
        </div>
      ) : null}
      {status?.recovery !== undefined ? (
        <p role="status">{t(`editorIntegration.recovery.${status.recovery}`)}</p>
      ) : installPhase === undefined ? null : (
        <p role="status">{installLabels[installPhase]}</p>
      )}
      {installPhase === 'failed' &&
      status !== undefined &&
      (status.installationErrorCode !== undefined || status.installationFailureKind !== undefined) ? (
        <p role="alert">
          {t(
            failureKey({
              name: '@dsh-vscode/editor-bridge',
              changed: false,
              application: 'failed',
              ...(status.installationErrorCode === undefined
                ? {}
                : { errorCode: status.installationErrorCode }),
              ...(status.installationFailureKind === undefined
                ? {}
                : { failureKind: status.installationFailureKind }),
            }),
          )}
        </p>
      ) : null}
      <div className="dsh-settings__actions">
        {installing || status?.canCancelInstall ? (
          <button
            type="button"
            className="dsh-button dsh-button--secondary"
            disabled={cancelling || status?.installation === 'cancelling'}
            onClick={() => void cancelInstall()}
          >
            {cancelling || status?.installation === 'cancelling'
              ? t('editorIntegration.cancellingInstall')
              : t('editorIntegration.cancelInstall')}
          </button>
        ) : null}
        <button
          type="button"
          className="dsh-button dsh-button--secondary"
          disabled={busy || request === undefined}
          onClick={() => action('retry')}
        >
          {busy
            ? t('editorIntegration.working')
            : status?.reason === 'untrusted'
              ? t('editorIntegration.manageTrust')
              : status?.reason === 'workspace'
                ? t('editorIntegration.chooseFolder')
                : t('editorIntegration.retry')}
        </button>
        {status?.canInstall &&
        (status.installed === false ||
          installPhase === 'failed' ||
          (phase !== 'ready' && status.reason !== 'workspace' && status.reason !== 'untrusted')) ? (
          <button
            type="button"
            className="dsh-button dsh-button--secondary"
            disabled={busy || status.packageManager === 'missing' || status.packageManager === 'broken'}
            onClick={() => action('setup')}
          >
            {status.installed === true ? t('editorIntegration.repair') : t('editorIntegration.install')}
          </button>
        ) : null}
        {status?.canRestart &&
        (installPhase === 'unknown' ||
          (phase !== 'ready' && status.reason !== 'workspace' && status.reason !== 'untrusted')) ? (
          <button
            type="button"
            className="dsh-button dsh-button--secondary"
            disabled={busy}
            onClick={() => action('restart')}
          >
            {t('editorIntegration.restart')}
          </button>
        ) : null}
        {status !== undefined && !status.canRestart && phase === 'limited' ? (
          <button
            type="button"
            className="dsh-button dsh-button--secondary"
            disabled={busy}
            onClick={() => action('start-managed')}
          >
            {t('editorIntegration.startManaged')}
          </button>
        ) : null}
        {status?.canUndo ? (
          <button
            type="button"
            className="dsh-button dsh-button--secondary"
            disabled={busy}
            onClick={() => action('undo')}
          >
            {t('editorIntegration.undo')}
          </button>
        ) : null}
      </div>
      {status?.canInstall ? (
        <details className="dsh-settings__environment">
          <summary>{t('editorIntegration.recoveryOptions')}</summary>
          <div className="dsh-settings__actions">
            {phase === 'ready' && status.installed === true ? (
              <button
                type="button"
                className="dsh-button dsh-button--secondary"
                disabled={busy}
                onClick={() => action('setup')}
              >
                {t('editorIntegration.repair')}
              </button>
            ) : null}
            <button
              type="button"
              className="dsh-button dsh-button--secondary"
              disabled={busy}
              onClick={() => action('restore')}
            >
              {t('editorIntegration.restore')}
            </button>
          </div>
        </details>
      ) : null}
    </SettingCard>
  )
}
