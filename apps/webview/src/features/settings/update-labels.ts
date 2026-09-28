import type {
  DshRuntimeUpdateProgress,
  DshUpdateSnapshot,
  ExtensionSettingsSummary,
} from '@dsh-vscode/domain'
import type { Translate } from '../../i18n.js'

export function dshUpdateFailureMessage(failure: DshUpdateSnapshot['failure'], t: Translate): string {
  switch (failure) {
    case 'npm-not-found':
      return t('settings.dshUpdateNpmMissing')
    case 'invalid-response':
      return t('settings.dshUpdateInvalidResponse')
    case 'registry-unavailable':
      return t('settings.dshUpdateRegistryUnavailable')
    default:
      return t('settings.dshUpdateUnavailable')
  }
}

export function dshUpdateProgressLabel(
  busy: 'check' | 'install',
  progress: DshRuntimeUpdateProgress | undefined,
  t: Translate,
): string {
  switch (progress?.phase) {
    case 'checking':
      return t('settings.dshUpdateProgressChecking')
    case 'downloading':
      return t('settings.dshUpdateProgressDownloading')
    case 'installing':
      return t('settings.dshUpdateProgressInstalling')
    case 'verifying':
      return t('settings.dshUpdateProgressVerifying')
    case 'completed':
      return t('settings.dshUpdateProgressCompleted')
    case 'failed':
      return t('settings.dshUpdateProgressFailed')
    default:
      return busy === 'check'
        ? t('settings.dshUpdateProgressChecking')
        : t('settings.dshUpdateProgressDownloading')
  }
}

export const DSH_UPDATE_PROGRESS_TOTAL_STAGES = 4

export function dshUpdateProgressStage(
  busy: 'check' | 'install' | undefined,
  progress: DshRuntimeUpdateProgress | undefined,
): number {
  switch (progress?.phase) {
    case 'checking':
      return 1
    case 'downloading':
    case 'installing':
      return 2
    case 'verifying':
      return 3
    case 'completed':
      return 4
    case 'failed':
      return busy === 'check' ? 1 : 2
    default:
      return busy === 'check' ? 1 : 2
  }
}

export function connectionModeLabel(
  mode: ExtensionSettingsSummary['connection']['mode'],
  t: Translate,
): string {
  if (mode === 'auto') return t('settings.automatic')
  if (mode === 'custom') return t('settings.connectionCustom')
  return mode
}
