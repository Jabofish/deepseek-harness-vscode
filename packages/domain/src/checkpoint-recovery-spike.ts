import { isCanonicalWorkspaceRelativePath } from './feature-contracts.js'

/** Hash-only checkpoint structures used by the in-memory recovery spike. */
export interface CheckpointFilePlan {
  readonly relativePath: string
  /** Hash observed immediately before the restore was prepared. */
  readonly expectedCurrentHash?: string
  /** Hash of the checkpoint content; content itself is never stored here. */
  readonly checkpointContentHash?: string
  readonly checkpointExists: boolean
}

export type CheckpointJournalState =
  'prepared' | 'applying' | 'committed' | 'rolled-back' | 'partial-restore' | 'conflict'

export interface CheckpointJournal {
  readonly operationId: string
  readonly state: CheckpointJournalState
  readonly plannedPaths: readonly string[]
  readonly appliedPaths: readonly string[]
  readonly rolledBackPaths: readonly string[]
  readonly failedPath?: string
}

export interface CheckpointConflict {
  readonly relativePath: string
  readonly expectedCurrentHash?: string
  readonly actualCurrentHash?: string
}

export interface CheckpointRestoreResult {
  readonly state: CheckpointJournalState
  readonly files: ReadonlyMap<string, string>
  readonly journal: CheckpointJournal
  readonly conflicts: readonly CheckpointConflict[]
}

export interface CheckpointStartupRecoveryResult {
  readonly state: 'rolled-back' | 'partial-restore' | 'unchanged'
  readonly files: ReadonlyMap<string, string>
  readonly recoveredPaths: readonly string[]
}

export function validateCheckpointPlan(paths: readonly CheckpointFilePlan[]): readonly string[] {
  return paths
    .map((entry) => entry.relativePath)
    .filter((relativePath) => !isCanonicalWorkspaceRelativePath(relativePath))
}

export function findCheckpointConflicts(
  currentFiles: ReadonlyMap<string, string>,
  plan: readonly CheckpointFilePlan[],
): readonly CheckpointConflict[] {
  return plan.flatMap((entry) => {
    const actual = currentFiles.get(entry.relativePath)
    return actual === entry.expectedCurrentHash
      ? []
      : [
          {
            relativePath: entry.relativePath,
            ...(entry.expectedCurrentHash === undefined
              ? {}
              : { expectedCurrentHash: entry.expectedCurrentHash }),
            ...(actual === undefined ? {} : { actualCurrentHash: actual }),
          },
        ]
  })
}

/**
 * Apply hash-only file actions in memory. `failAfter` and `rollbackFailureAt`
 * are fault-injection knobs for the spike; no checkpoint content file is
 * created and no platform filesystem API is touched.
 */
export function simulateCheckpointRestore(input: {
  readonly operationId: string
  readonly currentFiles: ReadonlyMap<string, string>
  readonly plan: readonly CheckpointFilePlan[]
  readonly failAfter?: number
  readonly rollbackFailureAt?: string
}): CheckpointRestoreResult {
  const conflicts = findCheckpointConflicts(input.currentFiles, input.plan)
  const invalidPaths = validateCheckpointPlan(input.plan)
  if (invalidPaths.length > 0 || conflicts.length > 0) {
    return {
      state: 'conflict',
      files: new Map(input.currentFiles),
      journal: {
        operationId: input.operationId,
        state: 'conflict',
        plannedPaths: input.plan.map((entry) => entry.relativePath),
        appliedPaths: [],
        rolledBackPaths: [],
        ...(invalidPaths[0] === undefined ? {} : { failedPath: invalidPaths[0] }),
      },
      conflicts,
    }
  }

  const backup = new Map(input.currentFiles)
  const files = new Map(input.currentFiles)
  const appliedPaths: string[] = []
  let failedPath: string | undefined
  for (let index = 0; index < input.plan.length; index += 1) {
    const entry = input.plan[index]
    if (entry === undefined) continue
    if (input.failAfter !== undefined && index >= input.failAfter) {
      failedPath = entry.relativePath
      break
    }
    if (entry.checkpointExists && entry.checkpointContentHash !== undefined) {
      files.set(entry.relativePath, entry.checkpointContentHash)
    } else {
      files.delete(entry.relativePath)
    }
    appliedPaths.push(entry.relativePath)
  }

  if (failedPath === undefined) {
    return {
      state: 'committed',
      files,
      journal: {
        operationId: input.operationId,
        state: 'committed',
        plannedPaths: input.plan.map((entry) => entry.relativePath),
        appliedPaths,
        rolledBackPaths: [],
      },
      conflicts: [],
    }
  }

  let rollbackComplete = true
  const rollbackAppliedPaths: string[] = []
  for (const relativePath of [...appliedPaths].reverse()) {
    if (relativePath === input.rollbackFailureAt) {
      rollbackComplete = false
      continue
    }
    if (backup.has(relativePath)) files.set(relativePath, backup.get(relativePath) as string)
    else files.delete(relativePath)
    rollbackAppliedPaths.push(relativePath)
  }
  return {
    state: rollbackComplete ? 'rolled-back' : 'partial-restore',
    files,
    journal: {
      operationId: input.operationId,
      state: rollbackComplete ? 'rolled-back' : 'partial-restore',
      plannedPaths: input.plan.map((entry) => entry.relativePath),
      appliedPaths,
      rolledBackPaths: rollbackAppliedPaths,
      failedPath,
    },
    conflicts: [],
  }
}

/** Recover an interrupted journal from the hash-only backup. */
export function recoverCheckpointRestore(input: {
  readonly journal: CheckpointJournal
  readonly currentFiles: ReadonlyMap<string, string>
  readonly backupFiles: ReadonlyMap<string, string>
  readonly rollbackFailureAt?: string
}): CheckpointStartupRecoveryResult {
  if (input.journal.state !== 'applying') {
    return { state: 'unchanged', files: new Map(input.currentFiles), recoveredPaths: [] }
  }
  const files = new Map(input.currentFiles)
  const recoveredPaths: string[] = []
  let complete = true
  for (const relativePath of [...input.journal.appliedPaths].reverse()) {
    if (relativePath === input.rollbackFailureAt) {
      complete = false
      continue
    }
    if (input.backupFiles.has(relativePath))
      files.set(relativePath, input.backupFiles.get(relativePath) as string)
    else files.delete(relativePath)
    recoveredPaths.push(relativePath)
  }
  return {
    state: complete ? 'rolled-back' : 'partial-restore',
    files,
    recoveredPaths,
  }
}
