import { Fragment, type ReactElement } from 'react'
import type { TimelineNode, TurnTokenUsage } from '@dsh-vscode/timeline'
import type {
  FeedbackCategory,
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageImageReference,
} from '@dsh-vscode/domain'
import { MarkdownContent } from './MarkdownContent.js'
import { MessageImages } from './MessageImages.js'
import { MessageActions } from './MessageActions.js'
import { containsUserTextReferences, projectUserText } from './UserText.js'
import { ReasoningDisclosure } from './ReasoningDisclosure.js'
import { ToolCallCollection, type ToolTimelineNode } from './ToolCallCollection.js'
import { WorkflowRunCard } from '../workflows/WorkflowDrawer.js'
import { Icon } from '../../ui/Icon.js'
import type { PerformanceUsageMode, TranscriptViewMode } from '../../app/ui-preferences.js'
import type { Translate } from '../../i18n.js'
import {
  assistantBlocksFromAggregates,
  assistantMessageId,
  type AssistantTurnNode,
  type DisplayTimelineNode,
  type ExpandedDetailsSetter,
  type FeedbackPrepare,
  type FeedbackSubmit,
  type TimelineNodeRenderContext,
  type UserTextFacts,
} from './timeline-shared.js'
import { formatEventPayload } from './timeline-projection.js'
import { producedFilePaths, renderDeliverables, renderProducedFiles } from './timeline-produced-files.js'
import {
  assistantMetricsLabel,
  assistantNodeInProgress,
  branchUnavailableForNode,
  compactionMeta,
  formatExactTokens,
  reasoningExpandedChange,
  turnTerminalLabel,
} from './timeline-labels.js'

function renderNode(
  node: DisplayTimelineNode,
  userTextFacts: ReadonlyMap<string, UserTextFacts>,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
  assistantLabel = 'Model',
  onOpenLink?: (href: string) => void,
  onLoadImage?: (image: MessageImageReference) => Promise<string | undefined>,
  onShowInFolder?: (href: string) => void,
  onOpenSession?: (sessionId: string) => void,
  onBranch?: (atSeq: number) => void,
  branchUnavailable = true,
  running = false,
  feedback?: Readonly<Record<string, MessageFeedbackItem>>,
  onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void,
  onFeedbackSubmit?: FeedbackSubmit,
  onFeedbackPrepare?: FeedbackPrepare,
  t: Translate = (key) => key,
  feedbackUnavailable = false,
  transcriptView: TranscriptViewMode = 'standard',
  performanceUsage: PerformanceUsageMode = 'detailed',
): ReactElement {
  switch (node.kind) {
    case 'tool':
      return (
        <ToolCallCollection
          tools={[node]}
          expanded={expanded}
          onExpandedChange={setExpanded}
          translate={t}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(onLoadImage === undefined ? {} : { onLoadImage })}
        />
      )
    case 'deliverables':
      return renderDeliverables(node, onOpenLink, onShowInFolder, t)
    case 'assistant-turn':
      return renderAssistantTurn(
        node,
        expanded,
        setExpanded,
        assistantLabel,
        onOpenLink,
        onLoadImage,
        onShowInFolder,
        t,
        onBranch,
        branchUnavailable,
        running,
        feedback,
        onFeedback,
        onFeedbackSubmit,
        onFeedbackPrepare,
        feedbackUnavailable,
        transcriptView,
        performanceUsage,
      )
    case 'goal':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="target" />
              </span>
              <strong>{t('timeline.goals')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">
              {t('timeline.items', { count: node.goals.length })}
            </span>
          </header>
          <ul className="dsh-timeline__event-list">
            {node.goals.map((goal) => (
              <li key={goal.id}>
                <span className="dsh-timeline__event-title">{goal.title}</span>
                <span className={`dsh-status-pill dsh-status-pill--${goal.status}`}>
                  {t(`goal.status.${goal.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )
    case 'todo':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="check" />
              </span>
              <strong>{t('app.todo')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">
              {t('timeline.items', { count: node.todos.length })}
            </span>
          </header>
          <ul className="dsh-timeline__event-list">
            {node.todos.map((todo) => (
              <li key={todo.id}>
                <span className="dsh-timeline__event-title">{todo.content}</span>
                <span className={`dsh-status-pill dsh-status-pill--${todo.status}`}>
                  {t(`todo.status.${todo.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )
    case 'compaction':
      return (
        <details className="dsh-timeline__card dsh-timeline__card--event">
          <summary className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="box" />
              </span>
              <strong>{t('timeline.contextCompaction')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">{compactionMeta(node.compaction, t)}</span>
          </summary>
          {node.compaction.summary === undefined ? null : (
            <MarkdownContent markdown={node.compaction.summary} onOpenLink={onOpenLink} />
          )}
        </details>
      )
    case 'retry':
      return (
        <p
          className={`dsh-timeline__retry${
            node.state === 'cancelled' ? ' dsh-timeline__retry--terminal' : ''
          }`}
          role="status"
        >
          {node.state === 'scheduled' ? (
            <span className="dsh-timeline__retry-shimmer" aria-hidden="true" />
          ) : null}
          <span>
            {node.state === 'cancelled'
              ? t('timeline.retryCancelled', { attempt: node.attempt })
              : node.state === 'started'
                ? t('timeline.retryStarted', { attempt: node.attempt })
                : node.attempt > 1
                  ? t('timeline.retryingAttempt', { attempt: node.attempt })
                  : t('timeline.retryConnectionLost')}
            {node.message === undefined ? '' : ` — ${node.message}`}
          </span>
        </p>
      )
    case 'workflow':
      return (
        <WorkflowRunCard
          workflow={node.workflow}
          {...(onOpenSession === undefined ? {} : { onOpenChild: onOpenSession })}
        />
      )
    case 'team':
      return renderTeamActivity(node.activity, t)
    case 'command-input':
      return (
        <article className="dsh-timeline__command-input" aria-label={t('timeline.commandInput')}>
          <Icon name="terminal" />
          <code>{node.text}</code>
        </article>
      )
    case 'notice':
      return (
        <p
          className={`dsh-timeline__notice dsh-timeline__notice--${node.level}`}
          role={node.level === 'error' ? 'alert' : 'status'}
        >
          {node.text}
        </p>
      )
    case 'turn-terminal':
      return (
        <p
          className={`dsh-timeline__turn-terminal dsh-timeline__turn-terminal--${node.reason}`}
          data-reason={node.reason}
          role="status"
        >
          <Icon name="alert" />
          <span className="dsh-timeline__turn-terminal-message">
            <span>{turnTerminalLabel(node.reason, t)}</span>
            {node.failure === undefined ? null : (
              <span className="dsh-timeline__turn-terminal-detail">
                {node.failure.code === undefined ? null : <code>{node.failure.code}</code>}
                <span>{node.failure.message}</span>
              </span>
            )}
          </span>
        </p>
      )
    case 'event-group':
      return (
        <details className="dsh-timeline__event-group">
          <summary className="dsh-timeline__event-group-summary">
            <span className="dsh-timeline__event-group-heading">
              <Icon name="terminal" />
              <span>{t('timeline.events')}</span>
            </span>
            <span className="dsh-timeline__event-group-meta">
              <span>{node.events.length}</span>
              <span className="dsh-timeline__disclosure" aria-hidden="true">
                <Icon name="chevron-down" />
              </span>
            </span>
          </summary>
          <ol className="dsh-timeline__event-group-list">
            {node.events.map((event) => (
              <li key={event.id} className="dsh-timeline__event-group-item">
                <code title={event.name}>{event.name}</code>
                <details className="dsh-timeline__event-payload">
                  <summary>{t('timeline.payload')}</summary>
                  <pre>{formatEventPayload(event.payload, t)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )
    case 'user-message': {
      const facts = userTextFacts.get(node.id)
      const sessionReferenceLabels = facts?.sessionReferenceLabels ?? []
      const projected = containsUserTextReferences(node.markdown, sessionReferenceLabels)
      return (
        <div className="dsh-timeline__message-stack dsh-timeline__message-stack--user">
          <article
            className="dsh-timeline__card dsh-timeline__card--user"
            aria-label={t('timeline.yourMessage')}
          >
            {node.attachments === undefined || node.attachments.length === 0 ? null : (
              <div className="dsh-timeline__attachments" aria-label={t('timeline.attachedFiles')}>
                {node.attachments.map((attachment, index) => (
                  <span
                    className="dsh-timeline__attachment"
                    key={`${attachment.name}:${index}`}
                    title={attachment.name}
                  >
                    <Icon name={attachment.mimeType?.startsWith('image/') === true ? 'image' : 'file'} />
                    <span>{attachment.name}</span>
                  </span>
                ))}
              </div>
            )}
            <MessageImages
              images={node.images ?? []}
              {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
              translate={t}
            />
            {node.markdown.trim() === '' ? null : projected ? (
              <div className="dsh-timeline__user-text">
                {projectUserText(
                  node.markdown,
                  sessionReferenceLabels,
                  onOpenLink === undefined ? undefined : { openFile: onOpenLink },
                )}
              </div>
            ) : (
              <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
            )}
            {sessionReferenceLabels.length === 0 ? null : (
              <div className="dsh-timeline__reference-summary" data-reference-summary="session">
                {t('timeline.referenceSummary', { labels: sessionReferenceLabels.join(', ') })}
              </div>
            )}
          </article>
          {node.markdown.trim() === '' ? null : <MessageActions text={node.markdown} translate={t} />}
        </div>
      )
    }
    case 'assistant-message':
      return renderAssistantMessage(
        node,
        expanded,
        setExpanded,
        assistantLabel,
        onOpenLink,
        onLoadImage,
        onShowInFolder,
        t,
        onBranch,
        branchUnavailable,
        running,
        feedback,
        onFeedback,
        onFeedbackSubmit,
        onFeedbackPrepare,
        feedbackUnavailable,
        transcriptView,
        performanceUsage,
      )
    case 'reasoning':
      if (transcriptView === 'compact') return <></>
      return renderAssistantTurn(
        {
          kind: 'assistant-turn',
          id: `assistant-turn:${node.id}`,
          tools: [],
          markdown: '',
          streaming: node.streaming,
          reasoning: node,
          blocks: [
            {
              kind: 'reasoning',
              id: node.id,
              markdown: node.markdown,
              streaming: node.streaming,
            },
          ],
        },
        expanded,
        setExpanded,
        assistantLabel,
        onOpenLink,
        onLoadImage,
        onShowInFolder,
        t,
        undefined,
        true,
        running,
        feedback,
        onFeedback,
        undefined,
        undefined,
        feedbackUnavailable,
        transcriptView,
        performanceUsage,
      )
  }
}

export function renderTimelineNode(
  node: DisplayTimelineNode,
  context: TimelineNodeRenderContext,
): ReactElement {
  return renderNode(
    node,
    context.userTextFacts,
    context.expandedDetails,
    context.setExpandedDetails,
    context.assistantLabel,
    context.onOpenLink === undefined ? undefined : context.requestOpenLink,
    context.onLoadImage,
    context.onShowInFolder,
    context.onOpenSession,
    context.onBranch,
    branchUnavailableForNode(node, context.branching),
    context.running,
    context.feedback,
    context.onFeedback,
    context.onFeedbackSubmit,
    context.onFeedbackPrepare,
    context.t,
    context.feedbackUnavailable,
    context.transcriptView,
    context.performanceUsage,
  )
}

function renderTeamActivity(
  activity: Extract<TimelineNode, { readonly kind: 'team' }>['activity'],
  t: Translate = (key) => key,
): ReactElement {
  const body =
    activity.kind === 'message.queued' || activity.kind === 'message.delivered' ? activity.content : undefined
  const title =
    activity.kind === 'member'
      ? activity.name
      : activity.kind === 'task'
        ? activity.subject
        : activity.messageId
  // The phase, task status and delivery values are wire identifiers; the pill
  // carries the reader-facing label and the delivery mode stays a meta detail
  // instead of replacing the message state.
  const statusKey =
    activity.kind === 'member'
      ? `timeline.teamStatus.${activity.phase}`
      : activity.kind === 'task'
        ? `timeline.teamStatus.${activity.status}`
        : activity.kind === 'message.queued'
          ? 'timeline.teamStatus.queued'
          : 'timeline.teamStatus.delivered'
  return (
    <section className="dsh-timeline__card dsh-timeline__card--event" aria-label={t('timeline.teamActivity')}>
      <header className="dsh-timeline__card-header">
        <div className="dsh-timeline__card-heading">
          <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
            <Icon name="users" />
          </span>
          <strong>{t('timeline.teamActivity')}</strong>
        </div>
        <span className="dsh-status-pill dsh-status-pill--info">{t(statusKey)}</span>
      </header>
      <ul className="dsh-timeline__event-list">
        <li>
          {body === undefined ? (
            <span className="dsh-timeline__event-title">{title}</span>
          ) : (
            // A peer message is prose, not a label: the host admits a body far
            // past one line (`maxMessageBytes`), so the row wraps it the way a
            // prompt row does instead of ending it in an ellipsis. A receipt
            // with no known body keeps the id fallback above.
            <span className="dsh-timeline__event-body">{body}</span>
          )}
          {activity.kind === 'task' && activity.blockedByCount > 0 ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamBlockedBy', { count: activity.blockedByCount })}
            </span>
          ) : null}
          {activity.kind === 'member' && activity.error !== undefined ? (
            // The roster stores the failure reason verbatim, so it is often a
            // multi-line diagnostic rather than a one-line label.
            <span className="dsh-timeline__event-error">{activity.error}</span>
          ) : null}
          {'senderName' in activity && activity.senderName !== undefined ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamSender', { sender: activity.senderName })}
            </span>
          ) : null}
          {'targetId' in activity && activity.targetId !== '' ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamTarget', { target: activity.targetId })}
            </span>
          ) : null}
          {'delivery' in activity && activity.delivery !== undefined ? (
            <span className="dsh-timeline__card-meta">{t(`timeline.teamDelivery.${activity.delivery}`)}</span>
          ) : null}
        </li>
      </ul>
    </section>
  )
}

function renderAssistantTurn(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
  assistantLabel: string,
  onOpenLink?: (href: string) => void,
  onLoadImage?: (image: MessageImageReference) => Promise<string | undefined>,
  onShowInFolder?: (href: string) => void,
  t: Translate = (key) => key,
  onBranch?: (atSeq: number) => void,
  branchUnavailable = true,
  running = false,
  feedback?: Readonly<Record<string, MessageFeedbackItem>>,
  onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void,
  onFeedbackSubmit?: FeedbackSubmit,
  onFeedbackPrepare?: FeedbackPrepare,
  feedbackUnavailable = false,
  transcriptView: TranscriptViewMode = 'standard',
  performanceUsage: PerformanceUsageMode = 'detailed',
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  const producedFiles = producedFilePaths(node.tools)
  const metricsLabel =
    performanceUsage === 'detailed' ? assistantMetricsLabel(node.timing, node.usage, t) : undefined
  const turnUsage =
    performanceUsage === 'detailed' && node.turnCompleted === true ? node.turnUsage : undefined
  const detailLabel =
    transcriptView === 'detailed' && node.turn !== undefined && node.step !== undefined
      ? t('timeline.stepMetadata', { turn: node.turn, step: node.step })
      : undefined
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {detailLabel === undefined ? null : <span className="dsh-timeline__card-meta">{detailLabel}</span>}
          {node.interrupted === true ? (
            <span className="dsh-timeline__card-meta">{t('timeline.interrupted')}</span>
          ) : null}
          {metricsLabel === undefined ? null : (
            <span className="dsh-timeline__assistant-metrics" title={metricsLabel}>
              {metricsLabel}
            </span>
          )}
        </header>
        {renderAssistantBlocks(
          node,
          expanded,
          setExpanded,
          onOpenLink,
          onLoadImage,
          t,
          producedFiles,
          transcriptView,
        )}
        {renderProducedFiles(producedFiles, onOpenLink, onShowInFolder, t)}
      </article>
      {turnUsage === undefined ? null : <TurnUsageDisclosure usage={turnUsage} translate={t} />}
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...feedbackActionProps(
            assistantMessageId(node),
            feedback,
            onFeedback,
            onFeedbackSubmit,
            onFeedbackPrepare,
            feedbackUnavailable,
          )}
          {...(onBranch === undefined
            ? {}
            : { onBranch: node.sequence === undefined ? () => undefined : () => onBranch(node.sequence!) })}
          branchUnavailable={branchUnavailable}
          translate={t}
        />
      )}
    </div>
  )
}

function renderAssistantMessage(
  node: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
  assistantLabel: string,
  onOpenLink: ((href: string) => void) | undefined,
  onLoadImage: ((image: MessageImageReference) => Promise<string | undefined>) | undefined,
  onShowInFolder: ((href: string) => void) | undefined,
  t: Translate,
  onBranch: ((atSeq: number) => void) | undefined,
  branchUnavailable: boolean,
  running = false,
  feedback?: Readonly<Record<string, MessageFeedbackItem>>,
  onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void,
  onFeedbackSubmit?: FeedbackSubmit,
  onFeedbackPrepare?: FeedbackPrepare,
  feedbackUnavailable = false,
  transcriptView: TranscriptViewMode = 'standard',
  performanceUsage: PerformanceUsageMode = 'detailed',
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  const metricsLabel =
    performanceUsage === 'detailed' ? assistantMetricsLabel(node.timing, node.usage, t) : undefined
  const turnUsage =
    performanceUsage === 'detailed' && node.turnCompleted === true ? node.turnUsage : undefined
  const detailLabel =
    transcriptView === 'detailed' && node.turn !== undefined && node.step !== undefined
      ? t('timeline.stepMetadata', { turn: node.turn, step: node.step })
      : undefined
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {detailLabel === undefined ? null : <span className="dsh-timeline__card-meta">{detailLabel}</span>}
          {node.interrupted === true ? (
            <span className="dsh-timeline__card-meta">{t('timeline.interrupted')}</span>
          ) : null}
          {metricsLabel === undefined ? null : (
            <span className="dsh-timeline__assistant-metrics" title={metricsLabel}>
              {metricsLabel}
            </span>
          )}
        </header>
        {node.reasoning === undefined ? null : (
          <ReasoningDisclosure
            id={`reasoning:${node.id}`}
            markdown={node.reasoning.markdown}
            streaming={node.reasoning.streaming}
            hideSettledPreview={transcriptView === 'compact'}
            expanded={expanded.has(`reasoning:${node.id}`)}
            onExpandedChange={reasoningExpandedChange(setExpanded, `reasoning:${node.id}`)}
            translate={t}
          />
        )}
        <MessageImages
          images={node.images ?? []}
          {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
          translate={t}
        />
        {node.markdown.trim() === '' ? null : (
          <MarkdownContent markdown={node.markdown} streaming={node.streaming} onOpenLink={onOpenLink} />
        )}
      </article>
      {turnUsage === undefined ? null : <TurnUsageDisclosure usage={turnUsage} translate={t} />}
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...feedbackActionProps(
            node.id,
            feedback,
            onFeedback,
            onFeedbackSubmit,
            onFeedbackPrepare,
            feedbackUnavailable,
          )}
          {...(onBranch === undefined
            ? {}
            : { onBranch: node.sequence === undefined ? () => undefined : () => onBranch(node.sequence!) })}
          branchUnavailable={branchUnavailable}
          translate={t}
        />
      )}
    </div>
  )
}

function renderAssistantBlocks(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
  onOpenLink: ((href: string) => void) | undefined,
  onLoadImage: ((image: MessageImageReference) => Promise<string | undefined>) | undefined,
  t: Translate,
  producedFiles: readonly string[],
  transcriptView: TranscriptViewMode,
): ReactElement[] {
  const blocks = node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks
  const lastMessageIndex = blocks.reduce(
    (last, block, index) => (block.kind === 'message' ? index : last),
    -1,
  )
  const rendered: ReactElement[] = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined) continue
    if (block.kind === 'reasoning') {
      rendered.push(
        <Fragment key={`reasoning:${block.id}:${index}`}>
          <ReasoningDisclosure
            id={`reasoning:${node.id}:${block.id}`}
            markdown={block.markdown}
            streaming={block.streaming}
            hideSettledPreview={transcriptView === 'compact'}
            expanded={expanded.has(`reasoning:${node.id}:${block.id}`)}
            onExpandedChange={reasoningExpandedChange(setExpanded, `reasoning:${node.id}:${block.id}`)}
            translate={t}
          />
        </Fragment>,
      )
      continue
    }
    if (block.kind === 'message') {
      rendered.push(
        <Fragment key={`message:${block.id}:${index}`}>
          <MessageImages
            images={block.images ?? []}
            {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
            translate={t}
          />
          {block.markdown.trim() === '' ? null : (
            <MarkdownContent
              markdown={block.markdown}
              streaming={block.streaming}
              onOpenLink={onOpenLink}
              {...(index === lastMessageIndex ? { producedFiles } : {})}
            />
          )}
        </Fragment>,
      )
      continue
    }

    const tools: ToolTimelineNode[] = [block.node]
    while (index + 1 < blocks.length && blocks[index + 1]?.kind === 'tool') {
      index += 1
      const next = blocks[index]
      if (next?.kind === 'tool') tools.push(next.node)
    }
    rendered.push(
      <div className="dsh-timeline__assistant-tools" key={`tools:${tools.map((tool) => tool.id).join('|')}`}>
        <ToolCallCollection
          tools={tools}
          expanded={expanded}
          onExpandedChange={setExpanded}
          translate={t}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(onLoadImage === undefined ? {} : { onLoadImage })}
        />
      </div>,
    )
  }

  return rendered
}

function feedbackActionProps(
  messageId: string | undefined,
  feedback: Readonly<Record<string, MessageFeedbackItem>> | undefined,
  onFeedback: ((messageId: string, rating: MessageFeedbackRating) => void) | undefined,
  onFeedbackSubmit: FeedbackSubmit | undefined,
  onFeedbackPrepare: FeedbackPrepare | undefined,
  feedbackUnavailable: boolean,
): {
  readonly feedbackRating?: MessageFeedbackRating
  readonly feedbackNote?: string
  readonly feedbackCategory?: FeedbackCategory
  readonly onFeedback?: (rating: MessageFeedbackRating) => void
  readonly onFeedbackSubmit?: (
    rating: MessageFeedbackRating,
    note: string | undefined,
    category: FeedbackCategory | undefined,
  ) => Promise<void> | void
  readonly onFeedbackPrepare?: () =>
    Promise<MessageFeedbackItem | undefined> | MessageFeedbackItem | undefined
  readonly feedbackUnavailable?: boolean
} {
  if (messageId === undefined || (onFeedback === undefined && onFeedbackSubmit === undefined)) return {}
  const item = feedback?.[messageId]
  const rating = item?.rating
  return {
    ...(rating === undefined ? {} : { feedbackRating: rating }),
    ...(item?.note === undefined ? {} : { feedbackNote: item.note }),
    ...(item?.category === undefined ? {} : { feedbackCategory: item.category }),
    ...(onFeedback === undefined
      ? {}
      : { onFeedback: (next: MessageFeedbackRating) => onFeedback(messageId, next) }),
    ...(onFeedbackSubmit === undefined
      ? {}
      : {
          onFeedbackSubmit: (
            next: MessageFeedbackRating,
            note: string | undefined,
            category: FeedbackCategory | undefined,
          ) => onFeedbackSubmit(messageId, next, note, category),
        }),
    ...(onFeedbackPrepare === undefined ? {} : { onFeedbackPrepare: () => onFeedbackPrepare(messageId) }),
    ...(feedbackUnavailable ? { feedbackUnavailable: true } : {}),
  }
}

function TurnUsageDisclosure(props: {
  readonly usage: TurnTokenUsage
  readonly translate: Translate
}): ReactElement {
  const { usage, translate } = props
  return (
    <details className="dsh-timeline__turn-usage" aria-label={translate('timeline.tokenUsage')}>
      <summary>{translate('timeline.tokenUsage')}</summary>
      <dl>
        <div>
          <dt>{translate('timeline.uncachedInputTokens')}</dt>
          <dd>{formatExactTokens(usage.inputTokens)}</dd>
        </div>
        <div>
          <dt>{translate('stats.output')}</dt>
          <dd>{formatExactTokens(usage.outputTokens)}</dd>
        </div>
        {usage.cacheReadTokens === undefined ? null : (
          <div>
            <dt>{translate('stats.cacheRead')}</dt>
            <dd>{formatExactTokens(usage.cacheReadTokens)}</dd>
          </div>
        )}
        {usage.cacheWriteTokens === undefined ? null : (
          <div>
            <dt>{translate('stats.cacheWrite')}</dt>
            <dd>{formatExactTokens(usage.cacheWriteTokens)}</dd>
          </div>
        )}
        {usage.reasoningTokens === undefined ? null : (
          <div>
            <dt>{translate('stats.reasoning')}</dt>
            <dd>{formatExactTokens(usage.reasoningTokens)}</dd>
          </div>
        )}
        <div>
          <dt>{translate('timeline.totalTokens')}</dt>
          <dd>{formatExactTokens(usage.totalTokens)}</dd>
        </div>
      </dl>
    </details>
  )
}

export function StreamingActivity(props: {
  readonly id: string
  readonly usingTool?: boolean
  readonly translate: Translate
}): ReactElement {
  const key = props.usingTool === true ? 'timeline.activity.usingTool' : 'timeline.activity.responding'
  return (
    <span className="dsh-timeline__streaming-status" role="status" aria-live="polite">
      <Icon name={props.usingTool === true ? 'tool' : 'sparkles'} />
      <span>{props.translate(key)}</span>
    </span>
  )
}
