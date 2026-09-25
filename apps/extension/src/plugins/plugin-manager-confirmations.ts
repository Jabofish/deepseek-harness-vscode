import type { PluginInstallConfirmation, PluginBuildApprovalConfirmation } from '@dsh-vscode/application'
import type { PluginManagerBundle, PluginSpecInspection } from '@dsh-vscode/domain'

export interface PluginManagerWarningOptions {
  readonly modal: true
  readonly detail: string
}

export type PluginManagerWarningPresenter = (
  message: string,
  options: PluginManagerWarningOptions,
  confirmLabel: string,
) => PromiseLike<string | undefined>

export type PluginManagerConfirmationText = (message: string, detail?: string) => string

/** Install code only after a Host-owned modal confirmation. */
export function createPluginInstallConfirmation(
  present: PluginManagerWarningPresenter,
  translate: PluginManagerConfirmationText,
): PluginInstallConfirmation {
  return async (spec: string, inspection: PluginSpecInspection) => {
    if (inspection.status !== 'accepted') return false
    const packageName =
      inspection.name ??
      (inspection.kind === 'git' || inspection.kind === 'tarball'
        ? (inspection.host ?? translate('this package source'))
        : translate('this package'))
    const confirmLabel = translate('Install plugin')
    const choice = await present(
      translate('Install DSH plugin "{0}"?', packageName),
      {
        modal: true,
        detail: translate(
          'This adds third-party code to the DSH profile. DSH may load it in its Host process outside the workspace sandbox. Review and trust the package before continuing.',
        ),
      },
      confirmLabel,
    )
    // `spec` is deliberately not included in a message or diagnostic; it may name a local path or private Git URL.
    void spec
    return choice === confirmLabel
  }
}

export function createPluginRemoveConfirmation(
  present: PluginManagerWarningPresenter,
  translate: PluginManagerConfirmationText,
): (bundle: PluginManagerBundle) => Promise<boolean> {
  return async (bundle) => {
    const confirmLabel = translate('Remove plugin')
    const choice = await present(
      translate('Remove DSH plugin "{0}" from this profile?', bundle.name),
      {
        modal: true,
        detail: translate(
          'This removes the package from the current DSH profile and affects every session using it.',
        ),
      },
      confirmLabel,
    )
    return choice === confirmLabel
  }
}

export function createPluginBuildApprovalConfirmation(
  present: PluginManagerWarningPresenter,
  translate: PluginManagerConfirmationText,
): PluginBuildApprovalConfirmation {
  return async (packages) => {
    const names = packages.join(', ')
    const confirmLabel = translate('Allow and retry')
    const choice = await present(
      translate('Allow install scripts for {0}?', names),
      {
        modal: true,
        detail: translate(
          'These package scripts can execute code during installation. Allow only packages you trust.',
        ),
      },
      confirmLabel,
    )
    return choice === confirmLabel
  }
}
