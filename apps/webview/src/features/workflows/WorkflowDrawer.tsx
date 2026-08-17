import { useState, type ReactElement } from 'react'
import type { WorkflowMember, WorkflowSummary } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'

export interface WorkflowRunCardProps {
  readonly workflow: WorkflowSummary
  /** Child ids come from the durable workflow record, never model text. */
  readonly onOpenChild?: (sessionId: string) => void
}

type WorkflowStatus = WorkflowSummary['status']
type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

function dotState(status: WorkflowStatus): string {
  switch (status) {
    case 'running':
      return 'ongoing'
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'cancelled':
    case 'interrupted':
      return 'warning'
  }
}

function statusWord(status: WorkflowStatus, t: Translate): string {
  return t(`workflow.status.${status}`)
}

function readablePhase(phase: string | null, t: Translate): string {
  if (phase === null) return t('workflow.unphased')
  return phase === '' ? t('workflow.emptyPhase') : phase
}

function readableMember(label: string, t: Translate): string {
  return label === '' ? t('workflow.emptyMember') : label
}

/** Match the official renderer: clean phases summarize only completed rows;
 * active outcomes take precedence, except interrupted runs retain their clean
 * count as useful context. */
function phaseSummary(members: readonly WorkflowMember[], t: Translate): string {
  const counts = new Map<WorkflowMember['status'], number>()
  for (const member of members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const active = (['running', 'failed', 'cancelled', 'interrupted'] as const).filter(
    (status) => (counts.get(status) ?? 0) > 0,
  )
  const visible: readonly WorkflowMember['status'][] =
    active.includes('interrupted') && (counts.get('completed') ?? 0) > 0
      ? ['completed', ...active]
      : active.length === 0
        ? ['completed']
        : active
  return visible
    .map((status) =>
      t('workflow.phase.summary', {
        status: statusWord(status, t),
        count: counts.get(status) ?? 0,
      }),
    )
    .join(' · ')
}

function requiresExpansion(members: readonly WorkflowMember[]): boolean {
  return members.some((member) => member.status !== 'completed')
}

function memberCount(workflow: WorkflowSummary): number {
  return workflow.stages.reduce((count, stage) => count + stage.members.length, 0)
}

/** Durable `tool-workflow/run-*` conversation node. There is intentionally no
 * start/cancel control: the pinned Host exposes workflow execution only to the
 * model-facing tool, not as a client RPC. */
export function WorkflowRunCard(props: WorkflowRunCardProps): ReactElement {
  const { workflow } = props
  const { t } = useI18n()
  const forceRunOpen =
    workflow.status !== 'completed' || workflow.stages.some((stage) => requiresExpansion(stage.members))
  const [runOpen, setRunOpen] = useState(false)
  const [manualPhases, setManualPhases] = useState<ReadonlySet<string>>(() => new Set())
  const open = forceRunOpen || runOpen
  const count = memberCount(workflow)

  return (
    <section className="dsh-workflow-runs__run" data-status={workflow.status}>
      <button
        type="button"
        className="dsh-workflow-runs__run-header"
        aria-expanded={open}
        onClick={() => {
          if (!forceRunOpen) setRunOpen((current) => !current)
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <strong className="dsh-workflow-runs__run-name" title={workflow.name}>
          {workflow.name}
        </strong>
        <span className="dsh-workflow-runs__run-count">
          {t(count === 1 ? 'workflow.member' : 'workflow.members', { count })}
        </span>
        <span className="dsh-jobs-popover__dot" data-state={dotState(workflow.status)} />
        <span className="dsh-workflow-runs__run-status">{statusWord(workflow.status, t)}</span>
      </button>
      {open ? (
        <div className="dsh-workflow-runs__phases">
          {workflow.stages.length === 0 ? (
            <span className="dsh-workflow-runs__empty">{t('workflow.noMembers')}</span>
          ) : (
            workflow.stages.map((stage) => {
              const forced = requiresExpansion(stage.members)
              const expanded = forced || manualPhases.has(stage.id)
              return (
                <div key={stage.id} className="dsh-workflow-runs__phase">
                  <button
                    type="button"
                    className="dsh-workflow-runs__phase-header"
                    aria-expanded={expanded}
                    onClick={() => {
                      if (forced) return
                      setManualPhases((current) => {
                        const next = new Set(current)
                        if (next.has(stage.id)) next.delete(stage.id)
                        else next.add(stage.id)
                        return next
                      })
                    }}
                  >
                    <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
                    <span className="dsh-workflow-runs__phase-label">{readablePhase(stage.phase, t)}</span>
                    <span className="dsh-workflow-runs__phase-count">
                      {t(stage.members.length === 1 ? 'workflow.member' : 'workflow.members', {
                        count: stage.members.length,
                      })}
                    </span>
                    <span className="dsh-workflow-runs__phase-summary">{phaseSummary(stage.members, t)}</span>
                  </button>
                  {expanded ? (
                    <div className="dsh-workflow-runs__members">
                      {stage.members.map((member) => {
                        const label = readableMember(member.label, t)
                        const content = (
                          <>
                            <span className="dsh-jobs-popover__dot" data-state={dotState(member.status)} />
                            <span className="dsh-workflow-runs__member-label" title={label}>
                              {label}
                            </span>
                            <span className="dsh-workflow-runs__member-status">
                              {statusWord(member.status, t)}
                            </span>
                          </>
                        )
                        return props.onOpenChild === undefined ? (
                          <div key={member.seq} className="dsh-workflow-runs__member">
                            {content}
                          </div>
                        ) : (
                          <button
                            key={member.seq}
                            type="button"
                            className="dsh-workflow-runs__member"
                            aria-label={t('workflow.openMember', { label })}
                            onClick={() => props.onOpenChild?.(member.childId)}
                          >
                            {content}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </section>
  )
}
