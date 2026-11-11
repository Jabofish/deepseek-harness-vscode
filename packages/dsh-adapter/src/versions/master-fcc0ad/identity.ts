import { AppError } from '@dsh-vscode/domain'

export const MASTER_FCC0AD_COMMIT = 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159'
export const MASTER_FCC0AD_RUNTIME_VERSION = '0.2.2-rc.1'

/** The Host caller establishes source identity before selecting this preparation. */
export function assertMasterFcc0adCommit(sourceCommit: string): void {
  if (sourceCommit !== MASTER_FCC0AD_COMMIT)
    throw new AppError({
      code: 'DSH_INCOMPATIBLE',
      message: 'This development Adapter requires its pinned upstream source commit.',
      retryable: false,
    })
}
