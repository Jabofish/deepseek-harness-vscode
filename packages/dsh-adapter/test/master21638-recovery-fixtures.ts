/**
 * Sanitized Session V4 shapes from `ToolCallRecovery.results()` at upstream
 * commit 21638c56315ae6a2b552d6091945d3144c9af32e. The call IDs and sequence
 * numbers are fixture-local; field names, error codes, message-ID pattern,
 * `isError`, source linkage, and outcome text follow the upstream producer.
 */
export const interruptedStartedToolResult = {
  type: 'tool/result',
  seq: 4,
  time: 120,
  surfaceOp: 'append',
  sourceEventSeqs: [3],
  data: {
    turn: 3,
    step: 2,
    message: {
      id: 'interrupted-tool-result-call-started-4',
      role: 'tool',
      toolCallId: 'call-started',
      isError: true,
      source: { kind: 'tool', callId: 'call-started' },
      content: [
        {
          type: 'text',
          text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
        },
      ],
    },
    error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
  },
} as const satisfies Record<string, unknown>

export const interruptedNotStartedToolResult = {
  type: 'tool/result',
  seq: 4,
  time: 120,
  surfaceOp: 'append',
  data: {
    turn: 3,
    step: 2,
    message: {
      id: 'interrupted-tool-result-call-pending-4',
      role: 'tool',
      toolCallId: 'call-pending',
      isError: true,
      source: { kind: 'tool', callId: 'call-pending' },
      content: [
        {
          type: 'text',
          text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
        },
      ],
    },
    error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
  },
} as const satisfies Record<string, unknown>
