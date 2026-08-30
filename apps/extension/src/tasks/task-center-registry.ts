import {
  AppError,
  isTaskTerminal,
  type BackendEvent,
  type DshBackend,
  type GoalView,
  type JobView,
  type SessionSummary,
  type SubagentCatalog,
  type TaskListQuery,
  type TaskRepository,
  type TaskSummary,
  type TaskSummaryStatus,
} from '@dsh-vscode/domain'

const MAX_TASKS = 200

export interface TaskCenterRegistryOptions {
  readonly now?: () => number
  /** Called with a session id after a structured source event arrives. */
  readonly onChange?: (sessionId: string) => void
}

interface PendingInteraction {
  readonly taskId: string
  readonly interactionId: string
  readonly sessionId: string
  readonly kind: 'approval' | 'question'
  readonly title: string
}

/**
 * Current-session task projection.
 *
 * The pinned DSH contract does not prove a global task seed/replay/ownership
 * API. This registry therefore composes only the authoritative repositories
 * already owned by the active backend, and never invents a cross-session
 * view. `process-stop` is intentionally unavailable unless a future managed
 * process control port is explicitly supplied.
 */
export class TaskCenterRegistry implements TaskRepository {
  private readonly entries = new Map<string, TaskSummary>()
  private readonly fingerprints = new Map<string, string>()
  private readonly revisions = new Map<string, number>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private readonly now: () => number
  private readonly onChange: TaskCenterRegistryOptions['onChange']
  private backend: DshBackend | undefined
  private workspaceFolderId: (() => string | undefined) | undefined
  private unsubscribe: (() => void) | undefined
  private currentSessionId: string | undefined
  private attachmentGeneration = 0

  public constructor(options: TaskCenterRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.onChange = options.onChange
  }

  public attach(backend: DshBackend, workspaceFolderId: () => string | undefined): void {
    this.detach()
    this.backend = backend
    this.workspaceFolderId = workspaceFolderId
    const attachmentGeneration = ++this.attachmentGeneration
    this.unsubscribe = backend.events.subscribe((event) => {
      if (attachmentGeneration !== this.attachmentGeneration) return
      this.rememberEvent(event)
    })
  }

  public detach(): void {
    this.attachmentGeneration += 1
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.backend = undefined
    this.workspaceFolderId = undefined
    this.currentSessionId = undefined
    this.entries.clear()
    this.interactions.clear()
  }

  public dispose(): void {
    this.detach()
    this.fingerprints.clear()
    this.revisions.clear()
  }

  public setCurrentSession(sessionId: string | undefined): void {
    this.currentSessionId = sessionId
  }

  public async list(query: TaskListQuery = {}, signal?: AbortSignal): Promise<readonly TaskSummary[]> {
    throwIfAborted(signal)
    const backend = this.requireBackend()
    const attachmentGeneration = this.attachmentGeneration
    const workspaceFolderId = query.workspaceFolderId ?? this.workspaceFolderId?.()
    if (workspaceFolderId === undefined) throw unavailable('the current workspace folder')
    const sessionId = query.sessionId ?? this.currentSessionId
    if (sessionId === undefined) throw unavailable('the current session')

    const [session, jobs, goals, subagents] = await Promise.all([
      backend.sessions.get(sessionId, signal),
      backend.jobs.list(sessionId, signal),
      backend.goals.list(sessionId, signal),
      backend.subagents.list(sessionId, signal),
    ])
    throwIfAborted(signal)
    if (!this.isCurrentAttachment(backend, attachmentGeneration))
      throw unavailable('the current DSH connection')

    const tasks = [
      this.sessionTask(session, workspaceFolderId, subagents),
      ...goals.map((goal) => this.goalTask(goal, session, workspaceFolderId)),
      ...jobs.map((job) => this.jobTask(job, session, workspaceFolderId)),
      ...this.subagentTasks(subagents, session, workspaceFolderId),
      ...this.interactionTasks(session, workspaceFolderId),
    ]
    const visible = tasks
      .filter((task) => query.includeCompleted === true || !isTaskTerminal(task.status))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId))
    const taskIds = new Set(tasks.map((task) => task.taskId))
    for (const [taskId, known] of this.entries) {
      if (
        !taskIds.has(taskId) &&
        (known.sessionId === sessionId || known.parentTaskId === `session:${sessionId}`)
      )
        this.entries.delete(taskId)
    }
    for (const task of tasks) this.entries.set(task.taskId, task)
    const offset = parseCursor(query.cursor)
    const limit = Math.min(Math.max(query.limit ?? MAX_TASKS, 1), MAX_TASKS)
    return visible.slice(offset, offset + limit)
  }

  public async get(taskId: string, signal?: AbortSignal): Promise<TaskSummary> {
    throwIfAborted(signal)
    const known = this.entries.get(taskId)
    if (known !== undefined) {
      // The projection is scoped to the current session: a task cached from a
      // previously current session must not stay readable (or actionable via
      // stop/answer) after the user switches sessions.
      if (!this.isInCurrentSessionScope(known)) throw taskNotOwned()
      return known
    }
    if (this.currentSessionId !== undefined) {
      const tasks = await this.list({ sessionId: this.currentSessionId, includeCompleted: true }, signal)
      const task = tasks.find((candidate) => candidate.taskId === taskId)
      if (task !== undefined) return task
    }
    throw taskUnavailable()
  }

  private isInCurrentSessionScope(task: TaskSummary): boolean {
    return (
      this.currentSessionId !== undefined &&
      (task.sessionId === this.currentSessionId || task.parentTaskId === `session:${this.currentSessionId}`)
    )
  }

  public async stop(
    taskId: string,
    mode: 'session-cancel' | 'process-stop',
    taskRevision: number,
    signal?: AbortSignal,
  ): Promise<TaskSummary> {
    throwIfAborted(signal)
    const task = await this.get(taskId, signal)
    this.assertRevision(task, taskRevision)
    if (mode === 'process-stop') throw taskNotOwned()
    if (!task.canSessionCancel) throw taskNotOwned()
    if (task.kind === 'subagent') await this.requireBackend().subagents.interrupt(task.sourceId, signal)
    else {
      if (task.sessionId === undefined) throw taskNotOwned()
      await this.requireBackend().sessions.cancel(task.sessionId, signal)
    }
    const next: TaskSummary = {
      ...task,
      status: 'cancelled',
      updatedAt: this.now(),
      taskRevision: task.taskRevision + 1,
    }
    this.entries.set(task.taskId, next)
    return next
  }

  public async answer(
    taskId: string,
    requestedInteractionId: string,
    answer: string,
    signal?: AbortSignal,
  ): Promise<TaskSummary> {
    throwIfAborted(signal)
    const task = await this.get(taskId, signal)
    const interaction = this.interactions.get(taskId)
    if (
      interaction === undefined ||
      interaction.interactionId !== requestedInteractionId ||
      task.interactionId !== requestedInteractionId ||
      !task.canAnswer
    )
      throw taskStateStale()
    if (answer.length > 100_000)
      throw new AppError({ code: 'CONTEXT_LIMIT', message: 'The answer is too large.', retryable: false })
    if (interaction.kind === 'approval')
      await this.requireBackend().interactions.respondToPermission(interaction.interactionId, answer, signal)
    else await this.requireBackend().interactions.respondToQuestion(interaction.interactionId, answer, signal)
    this.interactions.delete(taskId)
    const { interactionId, ...taskWithoutInteraction } = task
    void interactionId
    const next: TaskSummary = {
      ...taskWithoutInteraction,
      status: 'completed',
      needsUserAction: false,
      actionKind: 'none',
      canAnswer: false,
      updatedAt: this.now(),
      taskRevision: task.taskRevision + 1,
    }
    this.entries.set(taskId, next)
    return next
  }

  private sessionTask(
    session: SessionSummary,
    workspaceFolderId: string,
    subagents: SubagentCatalog,
  ): TaskSummary {
    const status = sessionStatus(session.status)
    return this.withRevision({
      taskId: `session:${session.id}`,
      sourceId: session.id,
      sessionId: session.id,
      workspaceFolderId,
      kind: 'session',
      title: boundedLabel(session.title || session.id),
      status,
      needsUserAction: status === 'needs-input',
      ...(status === 'needs-input' ? { actionKind: 'none' as const } : {}),
      ...(boundedOptional(session.modelLabel) === undefined
        ? {}
        : { modelLabel: boundedOptional(session.modelLabel) as string }),
      startedAt: parseTime(session.createdAt, this.now()),
      updatedAt: parseTime(session.updatedAt, this.now()),
      childCount: subagents.entries.filter((entry) => entry.kind === 'child').length,
      canOpen: true,
      canAnswer: false,
      canSessionCancel: status === 'running' || status === 'needs-input',
      canProcessStop: false,
      ownerKind: 'unknown',
      ...this.connectionFields(),
    })
  }

  private goalTask(goal: GoalView, session: SessionSummary, workspaceFolderId: string): TaskSummary {
    const status: TaskSummaryStatus =
      goal.status === 'in-progress'
        ? 'running'
        : goal.status === 'completed'
          ? 'completed'
          : goal.status === 'blocked'
            ? 'blocked'
            : 'idle'
    return this.withRevision({
      taskId: `goal:${goal.id}`,
      sourceId: goal.id,
      sessionId: session.id,
      parentTaskId: `session:${session.id}`,
      workspaceFolderId,
      kind: 'goal',
      title: boundedLabel(goal.title),
      status,
      needsUserAction: status === 'blocked',
      ...(status === 'blocked' ? { actionKind: 'none' as const } : {}),
      startedAt: 0,
      updatedAt: this.now(),
      childCount: 0,
      canOpen: true,
      canAnswer: false,
      canSessionCancel: false,
      canProcessStop: false,
      ownerKind: 'unknown',
      ...this.connectionFields(),
    })
  }

  private jobTask(job: JobView, session: SessionSummary, workspaceFolderId: string): TaskSummary {
    const status: TaskSummaryStatus =
      job.status === 'running'
        ? 'running'
        : job.status === 'stopping'
          ? 'cancelled'
          : job.status === 'completed'
            ? 'completed'
            : job.status === 'failed'
              ? 'failed'
              : 'cancelled'
    return this.withRevision({
      taskId: `job:${session.id}:${job.id}`,
      sourceId: job.id,
      sessionId: session.id,
      parentTaskId: `session:${session.id}`,
      workspaceFolderId,
      kind: 'job',
      title: boundedLabel(job.label || job.kind),
      status,
      needsUserAction: false,
      ...(job.detail === undefined ? {} : { actionKind: 'none' as const }),
      startedAt: job.startedAt,
      updatedAt: job.finishedAt ?? job.startedAt,
      childCount: 0,
      canOpen: false,
      canAnswer: false,
      canSessionCancel: false,
      canProcessStop: false,
      ownerKind: 'unknown',
      ...this.connectionFields(),
    })
  }

  private subagentTasks(
    catalog: SubagentCatalog,
    session: SessionSummary,
    workspaceFolderId: string,
  ): readonly TaskSummary[] {
    return catalog.entries.map((entry) => {
      if (entry.kind === 'diagnostic')
        return this.withRevision({
          taskId: `subagent:${entry.id}`,
          sourceId: entry.id,
          sessionId: session.id,
          parentTaskId: `session:${session.id}`,
          workspaceFolderId,
          kind: 'subagent',
          title: 'Unavailable subagent',
          status: 'unknown',
          needsUserAction: false,
          startedAt: 0,
          updatedAt: this.now(),
          childCount: 0,
          canOpen: false,
          canAnswer: false,
          canSessionCancel: false,
          canProcessStop: false,
          ownerKind: 'unknown',
          ...this.connectionFields(),
        })
      const status: TaskSummaryStatus = entry.activity === 'running' ? 'running' : 'idle'
      return this.withRevision({
        taskId: `subagent:${entry.id}`,
        sourceId: entry.id,
        sessionId: session.id,
        parentTaskId: `session:${session.id}`,
        workspaceFolderId,
        kind: 'subagent',
        title: boundedLabel(entry.label ?? entry.id),
        status,
        needsUserAction: false,
        startedAt: 0,
        updatedAt: this.now(),
        childCount: entry.hasChildren ? 1 : 0,
        canOpen: true,
        canAnswer: false,
        canSessionCancel: status === 'running' && entry.mode === 'continuable',
        canProcessStop: false,
        ownerKind: 'unknown',
        ...this.connectionFields(),
      })
    })
  }

  private interactionTasks(session: SessionSummary, workspaceFolderId: string): readonly TaskSummary[] {
    const values: TaskSummary[] = []
    for (const interaction of this.interactions.values()) {
      if (interaction.sessionId !== session.id) continue
      values.push(
        this.withRevision({
          taskId: interaction.taskId,
          sourceId: interaction.interactionId,
          sessionId: session.id,
          parentTaskId: `session:${session.id}`,
          workspaceFolderId,
          kind: 'interaction',
          title: boundedLabel(interaction.title),
          status: 'needs-input',
          needsUserAction: true,
          actionKind: interaction.kind,
          interactionId: interaction.interactionId,
          startedAt: 0,
          updatedAt: this.now(),
          childCount: 0,
          canOpen: true,
          canAnswer: true,
          canSessionCancel: false,
          canProcessStop: false,
          ownerKind: 'unknown',
          ...this.connectionFields(),
        }),
      )
    }
    return values
  }

  private withRevision(task: Omit<TaskSummary, 'taskRevision'>): TaskSummary {
    const fingerprint = JSON.stringify({
      ...task,
      updatedAt: undefined,
      taskRevision: undefined,
    })
    const previous = this.fingerprints.get(task.taskId)
    const revision = this.revisions.get(task.taskId) ?? 0
    const nextRevision = previous === fingerprint ? Math.max(revision, 1) : revision + 1
    this.fingerprints.set(task.taskId, fingerprint)
    this.revisions.set(task.taskId, nextRevision)
    return { ...task, taskRevision: nextRevision }
  }

  private connectionFields(): Pick<TaskSummary, 'backendInstanceId' | 'connectionGeneration'> {
    const connection = this.backend?.connection
    return {
      ...(connection?.backendInstanceId === undefined
        ? {}
        : { backendInstanceId: connection.backendInstanceId }),
      ...(connection?.connectionGeneration === undefined
        ? {}
        : { connectionGeneration: connection.connectionGeneration }),
    }
  }

  private rememberEvent(event: BackendEvent): void {
    const sessionId = eventSessionId(event)
    if (event.type === 'permission.requested') {
      const interaction = event.request
      const taskId = `interaction:permission:${interaction.id}`
      this.interactions.set(taskId, {
        taskId,
        interactionId: interaction.id,
        sessionId: interaction.sessionId,
        kind: 'approval',
        title: interaction.title,
      })
    } else if (event.type === 'question.requested') {
      const interaction = event.question
      const taskId = `interaction:question:${interaction.id}`
      this.interactions.set(taskId, {
        taskId,
        interactionId: interaction.id,
        sessionId: interaction.sessionId,
        kind: 'question',
        title: interaction.header ?? interaction.prompt,
      })
    } else if (event.type === 'permission.resolved') {
      this.removeInteraction(event.requestId, event.sessionId)
    } else if (event.type === 'question.resolved') {
      if (event.questionId !== undefined) this.removeInteraction(event.questionId, event.sessionId)
      if (event.questionRpcId !== undefined) this.removeInteraction(event.questionRpcId, event.sessionId)
    } else if (event.type === 'session.removed' && event.sessionId !== undefined) {
      for (const [taskId, interaction] of this.interactions)
        if (interaction.sessionId === event.sessionId) this.interactions.delete(taskId)
    }
    if (sessionId !== undefined) this.onChange?.(sessionId)
  }

  private removeInteraction(interactionId: string, sessionId: string): void {
    for (const [taskId, interaction] of this.interactions)
      if (interaction.sessionId === sessionId && interaction.interactionId === interactionId)
        this.interactions.delete(taskId)
  }

  private assertRevision(task: TaskSummary, expected: number): void {
    if (task.taskRevision !== expected) throw taskStateStale()
  }

  private requireBackend(): DshBackend {
    if (this.backend !== undefined) return this.backend
    throw new AppError({ code: 'BACKEND_UNREACHABLE', message: 'Connect to DSH first.', retryable: true })
  }

  private isCurrentAttachment(backend: DshBackend, attachmentGeneration: number): boolean {
    return this.backend === backend && this.attachmentGeneration === attachmentGeneration
  }
}

function eventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if (event.type === 'permission.requested') return event.request.sessionId
  if (event.type === 'question.requested') return event.question.sessionId
  return undefined
}

function sessionStatus(status: SessionSummary['status']): TaskSummaryStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'awaiting-input':
      return 'needs-input'
    case 'failed':
      return 'failed'
    case 'completed':
      return 'completed'
    case 'idle':
      return 'idle'
  }
}

function parseTime(value: string, fallback: number): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseCursor(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function boundedLabel(value: string): string {
  const trimmed = value.trim()
  return (trimmed === '' ? 'Untitled task' : trimmed).slice(0, 512)
}

function boundedOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 256)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The task request was cancelled.',
      retryable: true,
    })
}

function unavailable(subject: string): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: `Unable to resolve ${subject}.`,
    retryable: false,
  })
}

function taskUnavailable(): AppError {
  return new AppError({
    code: 'TASK_NOT_OWNED',
    message: 'The task is not owned by the current session.',
    retryable: false,
  })
}

function taskNotOwned(): AppError {
  return new AppError({
    code: 'TASK_NOT_OWNED',
    message: 'This task cannot be controlled by the extension.',
    retryable: false,
  })
}

function taskStateStale(): AppError {
  return new AppError({
    code: 'TASK_STATE_STALE',
    message: 'The task changed before the action was applied.',
    retryable: true,
  })
}
