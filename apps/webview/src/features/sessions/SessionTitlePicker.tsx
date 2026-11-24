import { memo, useMemo, type ReactElement } from 'react'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { useI18n } from '../../i18n.js'
import { displaySessionTitle } from './session-title.js'
import { workspaceDisplayName } from './session-drawer-model.js'

/** The title opens the same authorised navigation path as the session list. */
export const SessionTitlePicker = memo(function SessionTitlePicker(props: {
  readonly active: SessionSummary
  readonly sessions: readonly SessionSummary[]
  readonly workspaces?: readonly WorkspaceSummary[]
  readonly onOpen: (sessionId: string) => void
}): ReactElement {
  const { t } = useI18n()
  const { active, sessions, workspaces, onOpen } = props
  const options = useMemo(() => {
    const workspaceById = new Map((workspaces ?? []).map((ws) => [ws.id, workspaceDisplayName(ws.name, t)]))
    const showWorkspace = workspaceById.size > 1
    const available = sessions
      .filter((session) => session.origin !== 'subagent' && (!session.blank || session.id === active.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    const list = available.some((session) => session.id === active.id) ? available : [active, ...available]
    return list.map((session) => {
      const title = displaySessionTitle(session.title, t)
      const wsName =
        showWorkspace && session.workspaceId !== undefined
          ? workspaceById.get(session.workspaceId)
          : undefined
      return { value: session.id, label: wsName === undefined ? title : `${title} · ${wsName}` }
    })
  }, [active, sessions, t, workspaces])
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
