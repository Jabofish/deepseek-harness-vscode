import type { AgentConfiguration } from './models.js'

export type SessionStatus = 'idle' | 'running' | 'awaiting-input' | 'failed' | 'completed'

export interface SessionSummary {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: SessionStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly modelLabel?: string
}

export interface SessionDetail extends SessionSummary {
  readonly configuration: AgentConfiguration
  readonly goalIds: readonly string[]
  readonly parentSessionId?: string
}

export interface SessionCreateInput {
  readonly workspaceId: string
  readonly title?: string
  readonly configuration: AgentConfiguration
}

export interface SessionListQuery {
  readonly workspaceId?: string
  readonly search?: string
  readonly archived?: boolean
  readonly cursor?: string
  readonly limit?: number
}

export interface SessionPage {
  readonly items: readonly SessionSummary[]
  readonly nextCursor?: string
}

export interface PromptInput {
  readonly sessionId: string
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
}

export interface PromptAttachment {
  readonly uri: string
  readonly name: string
  readonly mimeType?: string
}

export type RunningInputMode = 'queue' | 'steer'

export interface QueuedInput {
  readonly id: string
  readonly sessionId: string
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
  readonly mode: RunningInputMode
  readonly createdAt: string
}
