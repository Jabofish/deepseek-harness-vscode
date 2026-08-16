import type {
  BackendEvent,
  ModelDescriptor,
  ModelProvider,
  SessionDetail,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export const rc6Mapper = {
  sessionSummary(value: unknown): SessionSummary {
    return unimplemented<SessionSummary>('rc6 session summary mapping', [
      'validate the upstream value structurally before reading it',
      'map ids, timestamps, workspace, status, title, and optional model label losslessly',
      `input type ${typeof value}`,
    ])
  },
  sessionDetail(value: unknown): SessionDetail {
    return unimplemented<SessionDetail>('rc6 session detail mapping', [
      'compose the validated session summary with agent configuration, goals, and parent session',
      `input type ${typeof value}`,
    ])
  },
  workspace(value: unknown): WorkspaceSummary {
    return unimplemented<WorkspaceSummary>('rc6 workspace mapping', [
      'validate and map path, counts, and timestamps without platform-specific path rewriting',
      `input type ${typeof value}`,
    ])
  },
  provider(value: unknown): ModelProvider {
    return unimplemented<ModelProvider>('rc6 model provider mapping', [
      'include dynamic provider fields',
      'never include secret values in the returned model',
      `input type ${typeof value}`,
    ])
  },
  model(value: unknown): ModelDescriptor {
    return unimplemented<ModelDescriptor>('rc6 model mapping', [
      'retain provider ownership and reasoning capabilities',
      `input type ${typeof value}`,
    ])
  },
  event(name: string, value: unknown): BackendEvent {
    return unimplemented<BackendEvent>('rc6 host and mux event normalization', [
      'cover session, message delta, tool, interaction, goal, job, subagent, and connection events',
      'preserve unknown event name and payload behind the unknown domain variant',
      'test every upstream event family with recorded redacted fixtures',
      `event ${name}; payload type ${typeof value}`,
    ])
  },
}
