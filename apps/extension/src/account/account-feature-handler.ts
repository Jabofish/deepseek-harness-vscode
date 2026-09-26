import { AppError } from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { AccountLifecycleHost } from './account-lifecycle-host.js'

type AccountFeatureRequest = Extract<
  FeatureRequest,
  {
    readonly type:
      | 'account.state'
      | 'account.signIn'
      | 'account.cancelSignIn'
      | 'account.signOutImpact'
      | 'account.signOut'
      | 'account.details.read'
      | 'account.bonus.ack'
      | 'account.page.open'
  }
>

export async function handleAccountFeatureRequest(
  request: AccountFeatureRequest,
  account: AccountLifecycleHost | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  if (account === undefined)
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The connected DSH version does not expose account lifecycle controls.',
      retryable: false,
    })
  if (request.type === 'account.state')
    return { kind: 'account.lifecycle', snapshot: await account.getState(signal) }
  if (request.type === 'account.signIn')
    return { kind: 'account.lifecycle', snapshot: await account.startSignIn(signal) }
  if (request.type === 'account.cancelSignIn')
    return {
      kind: 'account.lifecycle',
      snapshot: await account.cancelSignIn(request.payload.attemptId, signal),
    }
  if (request.type === 'account.signOutImpact')
    return { kind: 'account.impact', impact: await account.getSignOutImpact(signal) }
  if (request.type === 'account.details.read')
    return { kind: 'account.details', snapshot: await account.readDetails(signal) }
  if (request.type === 'account.bonus.ack')
    return {
      kind: 'account.bonus.ack',
      accepted: await account.acknowledgeBonus(request.payload.orderId, signal),
    }
  if (request.type === 'account.page.open') {
    await account.openAccountPage(request.payload.page, signal)
    return { kind: 'account.page.opened', page: request.payload.page }
  }
  const snapshot = await account.signOut(signal)
  return { kind: 'account.lifecycle', snapshot: snapshot ?? (await account.getState(signal)) }
}
