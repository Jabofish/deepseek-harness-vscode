import { memo, useMemo, type ReactElement } from 'react'
import type { SessionSummary } from '@dsh-vscode/domain'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { useI18n } from '../../i18n.js'
import { displaySessionTitle } from './session-title.js'

/** The title opens the same authorised navigation path as the session list. */
export const SessionTitlePicker = memo(function SessionTitlePicker(props: {
  readonly active: SessionSummary
  readonly sessions: readonly SessionSummary[]
  readonly onOpen: (sessionId: string) => void
}): ReactElement {
  const { t } = useI18n()
  const { active, sessions, onOpen } = props
  const options = useMemo(() => {
    const available = sessions.filter((session) => session.origin !== 'subagent')
    return (available.some((session) => session.id === active.id) ? available : [active, ...available]).map(
      (session) => ({ value: session.id, label: displaySessionTitle(session.title, t) }),
    )
  }, [active, sessions, t])
  return (
    <SelectMenu
      className="dsh-conversation__header-title dsh-session-title-picker"
      icon="session"
      label={displaySessionTitle(active.title, t)}
      ariaLabel={t('sessions.title')}
      title={t('sessions.title')}
      value={active.id}
      options={options}
      displayLabel
      placement="below"
      align="start"
      onChange={(sessionId) => {
        if (sessionId !== active.id) onOpen(sessionId)
      }}
    />
  )
})
