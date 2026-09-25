import type { PluginBundleUseCases } from '@dsh-vscode/application'
import type { OptionalPluginBundle } from '@dsh-vscode/domain'

export type PluginBundleFeatureRequest =
  | { readonly type: 'plugin.bundles.list'; readonly payload: Record<string, never> }
  | {
      readonly type: 'plugin.bundle.setEnabled'
      readonly payload: { readonly name: string; readonly enabled: boolean }
    }

/** Route only the catalog read and profile-wide optional bundle toggle. */
export async function handlePluginBundleFeatureRequest(
  request: PluginBundleFeatureRequest,
  bundles: PluginBundleUseCases,
  signal: AbortSignal,
  confirmEnable?: (bundle: OptionalPluginBundle) => Promise<boolean>,
): Promise<unknown> {
  switch (request.type) {
    case 'plugin.bundles.list': {
      const snapshot = await bundles.list(signal)
      return { kind: 'plugin.bundles', ...snapshot }
    }
    case 'plugin.bundle.setEnabled':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.setEnabled(
          request.payload.name,
          request.payload.enabled,
          signal,
          confirmEnable,
        ),
      }
  }
}
