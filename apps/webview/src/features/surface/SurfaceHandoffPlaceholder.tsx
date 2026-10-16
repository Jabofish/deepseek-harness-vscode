import type { ReactElement } from 'react'
import { EmptyState } from '@dsh-vscode/ui'
import { useI18n } from '../../i18n.js'

/**
 * The side-bar posture while one or more editor-area chat tabs are live.
 *
 * Exactly one surface renders the conversation at a time: the editor tab owns
 * it, and the side bar keeps this card so the user can pull the chat back or
 * pick another session. The editor surface never renders this component.
 */
export function SurfaceHandoffPlaceholder(props: {
  readonly editorChats: number
  readonly onMoveToSidebar: () => void
  readonly onOpenSessions: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <EmptyState
      title={t('surface.handoff.title')}
      description={t('surface.handoff.description', { count: props.editorChats })}
      actions={
        <>
          <button className="dsh-button dsh-button--primary" type="button" onClick={props.onMoveToSidebar}>
            {t('surface.handoff.moveBack')}
          </button>
          {/* Keeps a second route into the session switcher without competing
          with the primary "bring the chat back" action. */}
          <button className="dsh-button dsh-button--secondary" type="button" onClick={props.onOpenSessions}>
            {t('surface.handoff.openSessions')}
          </button>
        </>
      }
    />
  )
}
