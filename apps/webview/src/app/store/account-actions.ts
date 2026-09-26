import type {
  AccountLifecycleSnapshotDto,
  AccountProfileDetailsSnapshotDto,
  FeatureHostEvent,
  FeatureRequest,
} from '@dsh-vscode/webview-protocol'
import {
  accountLifecycleSnapshotSchema,
  accountProfileDetailsSnapshotSchema,
  accountSignOutImpactSchema,
} from '@dsh-vscode/webview-protocol'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import type { AppActions, AppState, StateSetter } from './types.js'
import { object } from './unknown-record.js'

export interface AccountActionHost {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
}

export type AccountActionMethods = Pick<
  AppActions,
  | 'loadAccountLifecycle'
  | 'startAccountSignIn'
  | 'cancelAccountSignIn'
  | 'checkAccountSignOutImpact'
  | 'signOutAccount'
  | 'loadAccountDetails'
  | 'acknowledgeAccountBonus'
  | 'openAccountPage'
>

export interface AccountActions {
  readonly methods: AccountActionMethods
  /** Answer one `account.*` feature event; false when it is not account traffic. */
  readonly applyFeatureEvent: (message: FeatureHostEvent) => boolean
  /** Reset both epochs when the backend process behind the panel changes. */
  readonly applyConnectionIdentity: (identity: string | undefined) => void
  /** Retire in-flight account work on dispose. */
  readonly invalidate: () => void
}

export function createAccountActions(host: AccountActionHost): AccountActions {
  const readState = (): AppState => host.getState()
  const setState = host.setState

  let accountOperationEpoch = 0
  let accountDetailsEpoch = 0
  let accountConnectionIdentity: string | undefined
  const parseAccountSnapshotPayload = (value: unknown): AccountLifecycleSnapshotDto | undefined => {
    const payload = object(value)
    if (payload?.kind !== 'account.lifecycle') return undefined
    const parsed = accountLifecycleSnapshotSchema.safeParse(payload.snapshot)
    return parsed.success ? parsed.data : undefined
  }
  const parseAccountDetailsPayload = (value: unknown): AccountProfileDetailsSnapshotDto | undefined => {
    const payload = object(value)
    if (payload?.kind !== 'account.details') return undefined
    const parsed = accountProfileDetailsSnapshotSchema.safeParse(payload.snapshot)
    return parsed.success ? parsed.data : undefined
  }
  const requestAccountSnapshot = async (
    request: Extract<
      FeatureRequest,
      { readonly type: 'account.state' | 'account.signIn' | 'account.cancelSignIn' | 'account.signOut' }
    >,
  ): Promise<AccountLifecycleSnapshotDto> => {
    const parsed = parseAccountSnapshotPayload(await host.client.featureRequest<unknown>(request))
    if (parsed === undefined) throw new Error(translate('account.requestFailed'))
    return parsed
  }
  const commitAccountSnapshot = (snapshot: AccountLifecycleSnapshotDto): void => {
    const clearDetails =
      snapshot.status !== 'credential-stored' || readState().accountLifecycle?.status !== snapshot.status
    if (clearDetails) accountDetailsEpoch += 1
    setState((current) => ({
      ...current,
      accountLifecycle: snapshot,
      accountLifecycleError: undefined,
      accountLifecycleRequestFailed: false,
      ...(clearDetails
        ? { accountProfileDetails: null, accountProfileLoading: false, accountProfileRequestFailed: false }
        : {}),
    }))
  }
  const runAccountSnapshotAction = async (
    request: Extract<
      FeatureRequest,
      { readonly type: 'account.signIn' | 'account.cancelSignIn' | 'account.signOut' }
    >,
    clearExpired = false,
  ): Promise<void> => {
    if (!readState().accountLifecycleAvailable) return
    const epoch = accountOperationEpoch
    setState((current) => ({
      ...current,
      accountLifecycleBusy: true,
      accountLifecycleRequestFailed: false,
      accountLifecycleError: undefined,
      ...(clearExpired ? { accountSessionExpired: false } : {}),
    }))
    try {
      const snapshot = await requestAccountSnapshot(request)
      if (epoch === accountOperationEpoch && readState().accountLifecycleAvailable)
        commitAccountSnapshot(snapshot)
    } catch {
      if (epoch === accountOperationEpoch)
        setState((current) => ({ ...current, accountLifecycleRequestFailed: true }))
    } finally {
      if (epoch === accountOperationEpoch)
        setState((current) => ({ ...current, accountLifecycleBusy: false }))
    }
  }

  const applyConnectionIdentity = (identity: string | undefined): void => {
    if (identity === accountConnectionIdentity) return
    accountConnectionIdentity = identity
    accountOperationEpoch += 1
    accountDetailsEpoch += 1
  }

  const applyFeatureEvent = (message: FeatureHostEvent): boolean => {
    if (
      message.name !== 'account.lifecycle.updated' &&
      message.name !== 'account.session-expired' &&
      message.name !== 'account.lifecycle.error'
    )
      return false
    if (message.name === 'account.lifecycle.updated') {
      const clearDetails =
        message.snapshot.status !== 'credential-stored' ||
        readState().accountLifecycle?.status !== message.snapshot.status
      if (clearDetails) accountDetailsEpoch += 1
      setState((current) => ({
        ...current,
        accountLifecycle: message.snapshot,
        accountLifecycleError: undefined,
        accountLifecycleRequestFailed: false,
        ...(clearDetails
          ? {
              accountProfileDetails: null,
              accountProfileLoading: false,
              accountProfileRequestFailed: false,
            }
          : {}),
      }))
    }
    if (message.name === 'account.session-expired') {
      accountDetailsEpoch += 1
      setState((current) => ({
        ...current,
        accountSessionExpired: true,
        accountProfileDetails: null,
        accountProfileLoading: false,
        accountProfileRequestFailed: false,
      }))
    }
    if (message.name === 'account.lifecycle.error')
      setState((current) => ({
        ...current,
        accountLifecycleError: message.code,
        accountLifecycleRequestFailed: true,
      }))

    return true
  }

  const methods: AccountActionMethods = {
    loadAccountLifecycle: async () => {
      if (!readState().accountLifecycleAvailable) return
      const epoch = accountOperationEpoch
      setState((current) => ({
        ...current,
        accountLifecycleLoading: true,
        accountLifecycleRequestFailed: false,
        accountLifecycleError: undefined,
      }))
      try {
        const snapshot = await requestAccountSnapshot({
          type: 'account.state',
          requestId: requestId(),
          payload: {},
        })
        if (epoch === accountOperationEpoch && readState().accountLifecycleAvailable)
          commitAccountSnapshot(snapshot)
      } catch {
        if (epoch === accountOperationEpoch)
          setState((current) => ({ ...current, accountLifecycleRequestFailed: true }))
      } finally {
        if (epoch === accountOperationEpoch)
          setState((current) => ({ ...current, accountLifecycleLoading: false }))
      }
    },
    startAccountSignIn: () =>
      runAccountSnapshotAction({ type: 'account.signIn', requestId: requestId(), payload: {} }, true),
    cancelAccountSignIn: (attemptId) =>
      runAccountSnapshotAction({
        type: 'account.cancelSignIn',
        requestId: requestId(),
        payload: { attemptId },
      }),
    checkAccountSignOutImpact: async () => {
      if (!readState().accountLifecycleAvailable) return
      const epoch = accountOperationEpoch
      try {
        const payload = object(
          await host.client.featureRequest<unknown>({
            type: 'account.signOutImpact',
            requestId: requestId(),
            payload: {},
          }),
        )
        const impact =
          payload?.kind === 'account.impact'
            ? accountSignOutImpactSchema.safeParse(payload.impact)
            : undefined
        if (epoch === accountOperationEpoch && impact?.success === true)
          setState((current) => ({ ...current, accountLifecycleImpact: impact.data }))
        else if (epoch === accountOperationEpoch)
          setState((current) => ({ ...current, accountLifecycleRequestFailed: true }))
      } catch {
        if (epoch === accountOperationEpoch)
          setState((current) => ({
            ...current,
            accountLifecycleImpact: 'unknown',
            accountLifecycleRequestFailed: true,
          }))
      }
    },
    signOutAccount: () =>
      runAccountSnapshotAction({ type: 'account.signOut', requestId: requestId(), payload: {} }),
    loadAccountDetails: async () => {
      if (!readState().accountLifecycleAvailable) return
      if (readState().accountLifecycle?.status !== 'credential-stored') {
        accountDetailsEpoch += 1
        setState((current) => ({
          ...current,
          accountProfileDetails: null,
          accountProfileLoading: false,
          accountProfileRequestFailed: false,
        }))
        return
      }
      const epoch = ++accountDetailsEpoch
      setState((current) => ({ ...current, accountProfileLoading: true, accountProfileRequestFailed: false }))
      try {
        const details = parseAccountDetailsPayload(
          await host.client.featureRequest<unknown>({
            type: 'account.details.read',
            requestId: requestId(),
            payload: {},
          }),
        )
        if (details === undefined) throw new Error(translate('account.profile.failed'))
        if (epoch === accountDetailsEpoch && readState().accountLifecycle?.status === 'credential-stored')
          setState((current) => ({
            ...current,
            accountProfileDetails: details,
            accountProfileRequestFailed: false,
          }))
      } catch {
        if (epoch === accountDetailsEpoch)
          setState((current) => ({ ...current, accountProfileRequestFailed: true }))
      } finally {
        if (epoch === accountDetailsEpoch)
          setState((current) => ({ ...current, accountProfileLoading: false }))
      }
    },
    acknowledgeAccountBonus: async (orderId) => {
      if (
        !readState().accountLifecycleAvailable ||
        readState().accountLifecycle?.status !== 'credential-stored'
      )
        return false
      const epoch = accountDetailsEpoch
      const payload = object(
        await host.client.featureRequest<unknown>({
          type: 'account.bonus.ack',
          requestId: requestId(),
          payload: { orderId },
        }),
      )
      if (payload?.kind !== 'account.bonus.ack' || typeof payload.accepted !== 'boolean')
        throw new Error(translate('account.profile.failed'))
      if (epoch !== accountDetailsEpoch || readState().accountLifecycle?.status !== 'credential-stored')
        return false
      return payload.accepted
    },
    openAccountPage: async (page) => {
      if (
        !readState().accountLifecycleAvailable ||
        readState().accountLifecycle?.status !== 'credential-stored'
      )
        throw new Error(translate('account.signedOut'))
      const payload = object(
        await host.client.featureRequest<unknown>({
          type: 'account.page.open',
          requestId: requestId(),
          payload: { page },
        }),
      )
      if (payload?.kind !== 'account.page.opened' || payload.page !== page)
        throw new Error(translate('account.profile.failed'))
    },
  }

  return {
    methods,
    applyFeatureEvent,
    applyConnectionIdentity,
    invalidate: () => {
      accountOperationEpoch += 1
      accountDetailsEpoch += 1
    },
  }
}
