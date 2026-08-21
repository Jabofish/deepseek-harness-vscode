import type { ReactElement } from 'react'
import type { SessionSummary } from '@dsh-vscode/domain'
import { useI18n, type Translate } from '../../i18n.js'
import { displaySessionTitle } from '../sessions/session-title.js'

interface LineageEntry {
  readonly id: string
  readonly title: string
  readonly subagent: boolean
}

export interface SessionLineageProps {
  readonly active: SessionSummary
  readonly activeSubagent?: {
    readonly id: string
    readonly label?: string
    readonly parentSessionId: string
  }
  readonly sessions: readonly SessionSummary[]
  readonly onOpenSession: (sessionId: string) => void
}

/**
 * Compact session breadcrumb for the conversation header. DSH's official
 * WebUI exposes the same parent/child lineage next to the session header;
 * the existing host-backed SubagentDrawer remains the full descendant tree.
 */
export function SessionLineage(props: SessionLineageProps): ReactElement {
  const { t } = useI18n()
  const entries = deriveLineage(props, t)
  return (
    <nav className="dsh-session-lineage" aria-label={t('sessions.lineage')}>
      {entries.map((entry, index) => (
        <span className="dsh-session-lineage__segment" key={entry.id}>
          {index === 0 ? null : (
            <span className="dsh-session-lineage__separator" aria-hidden="true">
              /
            </span>
          )}
          {index === entries.length - 1 ? (
            <span className="dsh-session-lineage__current" title={entry.title}>
              {entry.title}
            </span>
          ) : (
            <button
              className={`dsh-session-lineage__parent${entry.subagent ? ' dsh-session-lineage__parent--subagent' : ''}`}
              type="button"
              aria-label={t('sessions.openAncestor', { title: entry.title })}
              title={t('sessions.openAncestor', { title: entry.title })}
              onClick={() => props.onOpenSession(entry.id)}
            >
              {entry.title}
            </button>
          )}
        </span>
      ))}
    </nav>
  )
}

function deriveLineage(props: SessionLineageProps, t: Translate): readonly LineageEntry[] {
  const summaries = new Map(props.sessions.map((session) => [session.id, session]))
  const activeSubagent = props.activeSubagent
  const result: LineageEntry[] = [
    activeSubagent === undefined
      ? {
          id: props.active.id,
          title: displaySessionTitle(props.active.title, t),
          subagent: props.active.origin === 'subagent',
        }
      : {
          id: activeSubagent.id,
          title: displaySessionTitle(activeSubagent.label ?? '', t),
          subagent: true,
        },
  ]
  const seen = new Set(result.map((entry) => entry.id))
  let parentId = activeSubagent?.parentSessionId ?? props.active.parentSessionId
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = summaries.get(parentId)
    if (parent === undefined) break
    result.unshift({
      id: parent.id,
      title: displaySessionTitle(parent.title, t),
      subagent: parent.origin === 'subagent',
    })
    seen.add(parent.id)
    parentId = parent.origin === 'subagent' ? parent.parentSessionId : undefined
  }
  return result
}
