import type { AlphaErrorCodeNormalizer } from '../alpha/transport.js'

/**
 * Alpha.2 moved Remote failures into a shared namespaced vocabulary. The
 * existing repositories intentionally consume the local AppError mapping, so
 * the version seam normalizes only the known upstream codes before they reach
 * that mapper. Unknown codes remain unknown and fail closed as protocol drift.
 */
const ALPHA2_TO_LEGACY_RPC_CODE: Readonly<Record<string, string>> = {
  'gateway/bad-request': 'bad-request',
  'gateway/cancelled': 'cancelled',
  'gateway/internal': 'internal',
  'gateway/ambiguous-endpoint': 'bad-request',
  'gateway/arguments-invalid': 'bad-request',
  'gateway/binding-invalid': 'bad-request',
  'gateway/context-failed': 'internal',
  'gateway/context-not-found': 'unknown-command',
  'gateway/context-unavailable': 'internal',
  'gateway/definition-unavailable': 'unknown-command',
  'gateway/input-invalid': 'bad-request',
  'gateway/invocation-unavailable': 'unknown-command',
  'gateway/lookup-failed': 'internal',
  'gateway/lookup-not-found': 'unknown-command',
  'gateway/lookup-unavailable': 'internal',
  'gateway/method-unavailable': 'unknown-command',
  'gateway/provider-mismatch': 'bad-request',
  'gateway/result-invalid': 'internal',
  'gateway/service-unavailable': 'internal',
  'gateway/signature-invalid': 'bad-request',
  'session/not-found': 'session-not-found',
  'session/model-unavailable': 'model-unavailable',
  'session/conflict': 'session-conflict',
  'session/agent-busy': 'agent-busy',
  'session/invalid-time-zone': 'invalid-time-zone',
  'session/workspace-attach-failed': 'workspace-attach-failed',
  'agent-preset/conflict': 'agent-preset-conflict',
  'session/attachment-invalid': 'attachment-error',
  'session/queue-item-not-found': 'queue-item-not-found',
  'session/steer-unavailable': 'steer-unavailable',
  'session/title-invalid': 'title-invalid',
  'session/fork-unavailable': 'fork-unavailable',
  'subagent/not-found': 'subagent-not-found',
  'subagent/catalog-diagnostic': 'subagent-catalog-diagnostic',
  'settings/rejected': 'settings-rejected',
  'settings/conflict': 'settings-conflict',
  'credential/rejected': 'credential-rejected',
  'workspace/not-found': 'workspace-not-found',
  'workspace/invalid-path': 'workspace-invalid-path',
  'workspace/name-conflict': 'workspace-name-conflict',
  'workspace/move-invalid': 'workspace-move-invalid',
  'directory-picker/unavailable': 'directory-picker-unavailable',
  'directory-picker/unreadable': 'directory-unreadable',
  'directory-picker/exists': 'directory-exists',
  'directory-picker/create-failed': 'directory-create-failed',
  'subagent/invalid-time-zone': 'invalid-time-zone',
  'subagent/parent-unavailable': 'subagent-parent-unavailable',
  'subagent/not-resumable': 'subagent-not-resumable',
  'subagent/unauthorized': 'subagent-unauthorized',
  'subagent/attachment-invalid': 'attachment-error',
  'subagent/attachment-unsupported': 'attachment-error',
  'subagent/delivery-unavailable': 'subagent-delivery-unavailable',
  'subagent/projections-unavailable': 'subagent-catalog-diagnostic',
  'agent-preset/not-found': 'agent-preset-not-found',
  'agent-preset/invalid': 'agent-preset-invalid',
  'agent-preset/read-only': 'agent-preset-read-only',
  'agent-preset/locked': 'agent-preset-locked',
  'llm/model-discovery-rejected': 'model-discovery-failed',
}

/** Normalize a declared alpha.2 code; preserve unknown codes for fail-closed handling. */
export const normalizeAlpha2ErrorCode: AlphaErrorCodeNormalizer = (code) =>
  ALPHA2_TO_LEGACY_RPC_CODE[code] ?? code
