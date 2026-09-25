import { pluginLocalizedText, type OptionalPluginBundle } from '@dsh-vscode/domain'

export interface PluginBundleEnableWarningOptions {
  readonly modal: true
  readonly detail: string
}

export type PluginBundleWarningPresenter = (
  message: string,
  options: PluginBundleEnableWarningOptions,
  confirmLabel: string,
) => PromiseLike<string | undefined>

export type PluginBundleConfirmationText = (message: string, bundleTitle?: string) => string

/** Create the Host-owned modal gate for enabling profile-wide bundle code. */
export function createPluginBundleEnableConfirmation(
  present: PluginBundleWarningPresenter,
  translate: PluginBundleConfirmationText,
  locale: string,
): (bundle: OptionalPluginBundle) => Promise<boolean> {
  return async (bundle) => {
    const title = pluginLocalizedText(bundle.title, locale) ?? bundle.name
    const confirmLabel = translate('Enable bundle')
    const choice = await present(
      translate('Enable optional bundle "{0}" for the current DSH profile?', title),
      {
        modal: true,
        detail: translate(
          'This affects every session using this profile. Enabling the bundle may run its code in the DSH Host process outside the workspace sandbox. Continue only if you trust it; a restart may be required.',
        ),
      },
      confirmLabel,
    )
    return choice === confirmLabel
  }
}
