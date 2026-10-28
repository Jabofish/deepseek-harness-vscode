/** Sanitised dsh-v0.2.2-alpha.2 / f3803c96974ad4a94195fb97e5c637e9c2a3afe3.
 * session-controller/src/types.ts: SessionAttachmentRequest, SessionFollowRequest;
 * plugin-manager/src/types.ts: ChangeResult, ManagementError; llm/src/types.ts.
 * core/session/src/types.ts: tool/result; llm/llm/src/message.ts: ToolResultMessage.
 * IDs and diagnostic text are invented; the image is a generated 2x1 PNG.
 */
export const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='
export const imageReference = {
  attachmentId: 'fixture-image',
  mediaType: 'image/png' as const,
  bytes: Buffer.from(imageData, 'base64').length,
  width: 2,
  height: 1,
  name: 'fixture.png',
}
export const toolImageResult = {
  type: 'tool/result',
  seq: 3,
  time: 3,
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: 'fixture-tool-result',
      role: 'tool',
      toolCallId: 'fixture-tool-call',
      source: { kind: 'tool', callId: 'fixture-tool-call' },
      content: [{ type: 'image', attachment: imageReference }],
    },
  },
}
export const unsupportedPlatform = {
  target: 'fixture-bundle',
  enabled: true,
  changed: false,
  stage: 'enable',
  application: 'failed',
  error: { code: 'unsupported-platform', diagnostic: '/private/path token=private' },
}
