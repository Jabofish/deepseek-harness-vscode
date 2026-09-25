import type {
  PluginBuildApprovalConfirmation,
  PluginBundleEnableConfirmation,
  PluginBundleRemoveConfirmation,
  PluginBundleUseCases,
  PluginInstallConfirmation,
} from '@dsh-vscode/application'
import type { PluginRegistry } from '@dsh-vscode/domain'

export type PluginBundleFeatureRequest =
  | { readonly type: 'plugin.bundles.list'; readonly payload: Record<string, never> }
  | { readonly type: 'plugin.registries.list'; readonly payload: Record<string, never> }
  | {
      readonly type: 'plugin.spec.inspect'
      readonly payload: { readonly spec: string; readonly registry?: PluginRegistry | undefined }
    }
  | {
      readonly type: 'plugin.bundle.install'
      readonly payload: {
        readonly spec: string
        readonly installRequestId: string
        readonly registry?: PluginRegistry | undefined
        readonly approvedBuilds?: readonly string[] | undefined
      }
    }
  | { readonly type: 'plugin.bundle.cancelInstall'; readonly payload: { readonly installRequestId: string } }
  | {
      readonly type: 'plugin.bundle.setEnabled'
      readonly payload: { readonly name: string; readonly enabled: boolean }
    }
  | { readonly type: 'plugin.bundle.remove'; readonly payload: { readonly name: string } }
  | {
      readonly type: 'plugin.entry.setEnabled'
      readonly payload: { readonly entryId: string; readonly enabled: boolean }
    }

/** Route RC2 Plugin Manager operations through validated application use cases. */
export async function handlePluginBundleFeatureRequest(
  request: PluginBundleFeatureRequest,
  bundles: PluginBundleUseCases,
  signal: AbortSignal,
  confirmations?: {
    readonly enable?: PluginBundleEnableConfirmation
    readonly install?: PluginInstallConfirmation
    readonly remove?: PluginBundleRemoveConfirmation
    readonly builds?: PluginBuildApprovalConfirmation
  },
): Promise<unknown> {
  switch (request.type) {
    case 'plugin.bundles.list':
      return { kind: 'plugin.bundles', ...(await bundles.list(signal)) }
    case 'plugin.registries.list': {
      const registries = await bundles.registries(signal)
      return {
        kind: 'plugin.registries',
        available: registries !== undefined,
        registries: registries ?? null,
      }
    }
    case 'plugin.spec.inspect':
      return {
        kind: 'plugin.inspection',
        inspection: await bundles.inspect(request.payload.spec, request.payload.registry, signal),
      }
    case 'plugin.bundle.install':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.install(
          request.payload.spec,
          request.payload.installRequestId,
          request.payload.registry,
          request.payload.approvedBuilds,
          signal,
          confirmations?.install,
          confirmations?.builds,
        ),
      }
    case 'plugin.bundle.cancelInstall':
      return {
        kind: 'plugin.install.cancelled',
        ...(await bundles.cancelInstall(request.payload.installRequestId, signal)),
      }
    case 'plugin.bundle.setEnabled':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.setEnabled(
          request.payload.name,
          request.payload.enabled,
          signal,
          confirmations?.enable,
        ),
      }
    case 'plugin.bundle.remove':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.remove(request.payload.name, signal, confirmations?.remove),
      }
    case 'plugin.entry.setEnabled':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.setPluginEnabled(request.payload.entryId, request.payload.enabled, signal),
      }
  }
}
