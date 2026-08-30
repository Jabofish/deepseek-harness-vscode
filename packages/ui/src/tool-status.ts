import type { ToolCallView } from '@dsh-vscode/domain'

import type { PresentationTranslate } from './tool-presentation.js'

/**
 * One status vocabulary for every compact tool surface.  A collection summary
 * and a single tool card must not render different labels for the same DSH
 * state.
 */
export function toolStatusLabel(status: ToolCallView['status'], translate?: PresentationTranslate): string {
  const localize = (key: string, fallback: string): string =>
    translate === undefined ? fallback : translate(key)

  switch (status) {
    case 'queued':
      return localize('toolcard.status.queued', 'Queued')
    case 'running':
      return localize('toolcard.status.running', 'Running')
    case 'completed':
      return localize('toolcard.status.completed', 'Completed')
    case 'failed':
      return localize('toolcard.status.failed', 'Failed')
    case 'cancelled':
      return localize('toolcard.status.cancelled', 'Cancelled')
  }
}
