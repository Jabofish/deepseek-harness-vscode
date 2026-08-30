import type { TaskControlMode, TaskListQuery, TaskRepository, TaskSummary } from '@dsh-vscode/domain'

export class TaskUseCases {
  public constructor(private readonly tasks: TaskRepository) {}

  public list(query?: TaskListQuery, signal?: AbortSignal): Promise<readonly TaskSummary[]> {
    return this.tasks.list(query, signal)
  }

  public get(taskId: string, signal?: AbortSignal): Promise<TaskSummary> {
    return this.tasks.get(taskId, signal)
  }

  public stop(
    taskId: string,
    mode: TaskControlMode,
    taskRevision: number,
    signal?: AbortSignal,
  ): Promise<TaskSummary> {
    return this.tasks.stop(taskId, mode, taskRevision, signal)
  }

  public answer(
    taskId: string,
    interactionId: string,
    answer: string,
    signal?: AbortSignal,
  ): Promise<TaskSummary> {
    return this.tasks.answer(taskId, interactionId, answer, signal)
  }
}
