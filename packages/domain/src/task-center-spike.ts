/**
 * Task Center data-source spike. It is deliberately not a repository or a
 * UI model: it records what the current DSH contracts can prove before a
 * global task view is exposed.
 */

export type TaskCenterSource = 'global-seed' | 'current-session-fallback'
export type TaskCenterTaskStatus =
  | 'running'
  | 'idle'
  | 'needs-input'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'disconnected'
  | 'unknown'
export type TaskControlAction = 'session-cancel' | 'process-stop'
export type TaskOwnerKind = 'extension' | 'external' | 'unknown'

export interface TaskCenterEvidence {
  readonly globalSeed: boolean
  readonly replay: boolean
  readonly parentChild: boolean
  readonly ownership: boolean
}

export interface TaskCenterTask {
  readonly taskId: string
  readonly sessionId?: string
  readonly parentTaskId?: string
  readonly workspaceFolderId: string
  readonly status: TaskCenterTaskStatus
  readonly ownerKind: TaskOwnerKind
  readonly taskRevision: number
  readonly canSessionCancel: boolean
  readonly canProcessStop: boolean
}

export interface TaskCenterSnapshot {
  readonly source: TaskCenterSource
  readonly tasks: readonly TaskCenterTask[]
  readonly reason?: string
}

export interface TaskCenterNode {
  readonly task: TaskCenterTask
  readonly children: readonly TaskCenterNode[]
}

export function selectTaskCenterSource(
  evidence: TaskCenterEvidence,
  globalTasks: readonly TaskCenterTask[] | undefined,
): TaskCenterSource {
  return globalTasks !== undefined && Object.values(evidence).every(Boolean)
    ? 'global-seed'
    : 'current-session-fallback'
}

export function buildTaskCenterSnapshot(input: {
  readonly currentSessionId: string
  readonly sessionTasks: readonly TaskCenterTask[]
  readonly globalTasks?: readonly TaskCenterTask[]
  readonly evidence: TaskCenterEvidence
}): TaskCenterSnapshot {
  const source = selectTaskCenterSource(input.evidence, input.globalTasks)
  if (source === 'global-seed' && input.globalTasks !== undefined) {
    return { source, tasks: input.globalTasks }
  }
  return {
    source,
    tasks: input.sessionTasks.filter((task) => task.sessionId === input.currentSessionId),
    reason:
      'Global seed/replay/parent-child/ownership evidence is incomplete; using current-session fallback.',
  }
}

/** Build a stable parent-child view while keeping orphaned tasks visible. */
export function buildTaskCenterHierarchy(tasks: readonly TaskCenterTask[]): readonly TaskCenterNode[] {
  const byId = new Map<string, TaskCenterTask>()
  for (const task of tasks) {
    if (!byId.has(task.taskId)) byId.set(task.taskId, task)
  }
  const children = new Map<string, TaskCenterTask[]>()
  const roots: TaskCenterTask[] = []
  for (const task of byId.values()) {
    if (task.parentTaskId !== undefined && byId.has(task.parentTaskId)) {
      const siblings = children.get(task.parentTaskId) ?? []
      siblings.push(task)
      children.set(task.parentTaskId, siblings)
    } else {
      roots.push(task)
    }
  }
  const visited = new Set<string>()
  const visit = (task: TaskCenterTask, ancestors: ReadonlySet<string>): TaskCenterNode => {
    // A malformed cycle must not recurse forever; expose the current node and
    // stop at the cycle boundary until the source is repaired.
    if (ancestors.has(task.taskId)) return { task, children: [] }
    visited.add(task.taskId)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(task.taskId)
    return {
      task,
      children: (children.get(task.taskId) ?? []).map((child) => visit(child, nextAncestors)),
    }
  }
  const hierarchy = roots.map((task) => visit(task, new Set()))
  // A parent cycle has no natural root. Keep those tasks visible as an
  // additional root instead of silently dropping malformed source data.
  for (const task of byId.values()) {
    if (!visited.has(task.taskId)) hierarchy.push(visit(task, new Set()))
  }
  return hierarchy
}

/** Process stop is reserved for extension-owned managed processes. */
export function canControlTask(task: TaskCenterTask, action: TaskControlAction): boolean {
  if (action === 'session-cancel') return task.sessionId !== undefined && task.canSessionCancel
  return task.ownerKind === 'extension' && task.canProcessStop
}
