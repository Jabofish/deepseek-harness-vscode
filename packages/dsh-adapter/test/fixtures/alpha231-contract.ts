/**
 * Sanitised fixtures for the Session V4 wire shared by dsh-v0.2.3-alpha.1
 * (d98f5d68519215da48f3002da2cb9c9d2068d81d) and dsh-v0.2.3-alpha.2
 * (4b399c39a6d1479cd84ca591b4d7c88e24d38a96).
 * packages/session/working-directory/src/index.ts: SessionEventMap.
 * packages/interaction/action-cards/src/types.ts: ActionCardDecision.
 * packages/llm/llm/src/message.ts: SystemPromptMessageSource.
 */
export const alpha231DirectoryEvents = {
  legacy: { type: 'working-directory/change', seq: 4, time: 1_004, data: { cwd: '/fixture/old' } },
  current: { type: 'workspace-root/change', seq: 5, time: 1_005, data: { cwd: 'C:\\fixture\\worktree' } },
} as const

export const alpha231CardDecision = {
  type: 'action-cards/decision',
  seq: 6,
  time: 1_006,
  data: { cardId: 'fixture-answer', action: 'save', phase: 'settled', data: { path: '/fixture/private' } },
} as const

export const alpha231SystemUpdate = {
  type: 'system/message',
  seq: 7,
  time: 1_007,
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'system',
      id: 'fixture-instructions',
      source: {
        kind: 'system-prompt',
        reset: true,
        sections: [{ name: 'fixture-scope', state: 'active', order: 1, contentIndex: 0 }],
      },
      content: [{ type: 'text', text: 'Private fixture instructions' }],
    },
  },
} as const
