/** Sanitised ce7073d51254c26cd63b22a60835b8f948deb447:
 * packages/fs/tool-fs/src/apply-patch-output.ts: patchToolValue / patchPresentationMeta;
 * packages/core/session/src/types.ts: tool/result. Partial moves can have one known effect.
 * No raw canonical value or whole-file baselines are carried in presentation metadata.
 */
export const masterPatchResult = {
  type: 'tool/result',
  seq: 5,
  time: 5,
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: 'patch-result-1',
      role: 'tool',
      toolCallId: 'patch-1',
      source: { kind: 'tool', callId: 'patch-1' },
      content: [
        {
          type: 'text',
          text: 'Patch stopped after 1 of 3 operations.\nCompleted:\nM src/first.ts\nFailed: source could not be removed\nNot executed: src/skipped.ts',
        },
      ],
    },
    meta: {
      stopped: true,
      diffs: [
        { path: 'src/first.ts', oldText: 'const first = 1', newText: 'const first = 2' },
        { path: 'src/moved.ts', oldText: 'previous destination', newText: 'known written destination' },
      ],
    },
  },
} as const
