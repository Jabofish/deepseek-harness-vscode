import type {
  AccountLifecycleLabels,
  AccountLifecycleUiError,
  AccountLifecycleUiPhase,
} from '../account/AccountLifecycle.js'
import type { AccountProfileLabels } from '../account/AccountProfile.js'
import type { Translate } from '../../i18n.js'

export function accountProfileLabels(t: Translate): AccountProfileLabels {
  return {
    title: t('account.profile.title'),
    refresh: t('account.profile.refresh'),
    profile: t('account.profile.profile'),
    balance: t('account.profile.balance'),
    bonusBalance: t('account.profile.bonusBalance'),
    bonusNotice: t('account.profile.bonusNotice'),
    signedOut: t('account.signedOut'),
    unavailable: t('account.profile.unavailable'),
    failed: t('account.profile.failed'),
    noBalance: t('account.profile.noBalance'),
    unnamed: t('account.profile.unnamed'),
    dismissBonus: t('account.profile.dismissBonus'),
    retryBonus: t('account.profile.retryBonus'),
    usage: t('account.profile.usage'),
    topUp: t('account.profile.topUp'),
  }
}

export function accountLifecycleLabels(t: Translate): AccountLifecycleLabels {
  const phases: Record<AccountLifecycleUiPhase, string> = {
    initializing: t('account.phase.initializing'),
    'waiting-browser': t('account.phase.waitingBrowser'),
    exchanging: t('account.phase.exchanging'),
    committing: t('account.phase.committing'),
    succeeded: t('account.phase.succeeded'),
    cancelled: t('account.phase.cancelled'),
    expired: t('account.phase.expired'),
    failed: t('account.phase.failed'),
  }
  const errors: Record<AccountLifecycleUiError, string> = {
    network: t('account.error.network'),
    protocol: t('account.error.protocol'),
    expired: t('account.error.expired'),
    storage: t('account.error.storage'),
  }
  return {
    title: t('account.title'),
    loading: t('account.loading'),
    signedOut: t('account.signedOut'),
    credentialStored: t('account.credentialStored'),
    signIn: t('account.signIn'),
    cancelSignIn: t('account.cancelSignIn'),
    checkSignOutImpact: t('account.checkSignOutImpact'),
    signOut: t('account.signOut'),
    sessionExpired: t('account.sessionExpired'),
    requestFailed: t('account.requestFailed'),
    retry: t('account.retry'),
    phases,
    errors,
    hostErrors: {
      'state-stream-failed': t('account.hostError.stateStream'),
      'expiry-stream-failed': t('account.hostError.expiryStream'),
      'browser-open-failed': t('account.hostError.browserOpen'),
    },
    impacts: {
      none: t('account.impact.none'),
      running: t('account.impact.running'),
      unknown: t('account.impact.unknown'),
    },
  }
}
