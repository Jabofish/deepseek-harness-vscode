import { describe, expect, it } from 'vitest'

import {
  featureHostEventSchema,
  featureRequestSchema,
  featureResponseSchema,
  featureWebviewEnvelopeSchema,
  hostResponseSchema,
} from '../packages/webview-protocol/src/index.js'

const identity = {
  backendInstanceId: 'backend-1',
  connectionGeneration: 2,
  stream: 'mux',
  sessionId: 'session-1',
  serverSeq: 12,
} as const

const change = {
  changeId: 'change-1',
  sessionId: 'session-1',
  workspaceFolderId: 'workspace-1',
  relativePath: 'src/main.ts',
  status: 'modified',
  evidence: 'structured-tool-success',
  applicationState: 'applied-observed',
  reviewState: 'unreviewed',
  sourceIds: ['call-1'],
  locations: [{ relativePath: 'src/main.ts', line: 1 }],
  firstSeenAt: 1_000,
  lastSeenAt: 2_000,
  identity,
  diffAvailable: true,
} as const

const contextItem = (index: number, sizeBytes = 1): Record<string, unknown> => ({
  contextRef: `context-${index}`,
  kind: 'selection' as const,
  label: `Selection ${index}`,
  workspaceFolderId: 'workspace-1',
  relativePath: 'src/main.ts',
  range: { start: { line: 1, column: 0 }, end: { line: 2, column: 4 } },
  sizeBytes,
  stale: false,
  previewAvailable: true,
  expiresAt: 2_000,
  scope: {
    ownerId: 'view-1',
    workspaceFolderId: 'workspace-1',
    ownerViewId: 'view-1',
    sessionId: 'session-1',
    backendInstanceId: 'backend-1',
    connectionGeneration: 2,
    expiresAt: 2_000,
  },
})

describe('staged feature protocol contracts', () => {
  it('accepts safe discriminated requests without accepting arbitrary payloads', () => {
    expect(
      featureRequestSchema.safeParse({
        type: 'editor.context.capture',
        requestId: 'context-capture',
        payload: { kind: 'selection', workspaceFolderId: 'workspace-1' },
      }).success,
    ).toBe(true)
    expect(
      featureRequestSchema.safeParse({
        type: 'tasks.stop',
        requestId: 'task-stop',
        payload: { taskId: 'task-1', taskRevision: 4 },
      }).success,
    ).toBe(true)
    expect(
      featureRequestSchema.safeParse({
        type: 'navigation.open',
        requestId: 'navigate',
        payload: {
          workspaceFolderId: 'workspace-1',
          relativePath: 'src/main.ts',
          reveal: 'focus',
        },
      }).success,
    ).toBe(true)
    expect(
      featureRequestSchema.safeParse({
        type: 'tasks.stop',
        requestId: 'task-stop-extra',
        payload: {
          taskId: 'task-1',
          taskRevision: 4,
          response: 'raw model response',
        },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'tasks.stop',
        requestId: 'task-old-generation',
        payload: {
          taskId: 'task-1',
          mode: 'session-cancel',
          taskRevision: 4,
          connectionGeneration: 1,
        },
      }).success,
    ).toBe(false)
  })

  it('rejects absolute paths, URI paths, traversal, and secret-shaped fields', () => {
    for (const relativePath of ['C:/repo/file.ts', '/repo/file.ts', 'file:///repo/file.ts', '../file.ts']) {
      expect(
        featureRequestSchema.safeParse({
          type: 'navigation.open',
          requestId: `navigate-${relativePath}`,
          payload: { workspaceFolderId: 'workspace-1', relativePath },
        }).success,
      ).toBe(false)
    }
    expect(
      featureRequestSchema.safeParse({
        type: 'editor.context.capture',
        requestId: 'context-uri',
        payload: { kind: 'open-document', uri: 'file:///secret.ts' },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'prompt.template.create',
        requestId: 'template',
        payload: {
          sessionId: 'session-1',
          workspaceFolderId: 'workspace-1',
          title: 'Review',
          description: 'Review the current change.',
          templateText: 'Use the current editor context.',
          scope: 'workspace',
          variables: [],
          apiKey: 'must-not-be-a-protocol-field',
        },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'prompt.template.update',
        requestId: 'template-empty-update',
        payload: {
          templateId: 'template-1',
          sessionId: 'session-1',
          workspaceFolderId: 'workspace-1',
        },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'prompt.template.create',
        requestId: 'template-raw-body',
        payload: {
          sessionId: 'session-1',
          workspaceFolderId: 'workspace-1',
          title: 'Review',
          description: 'Review the current change.',
          body: 'Raw response must not be accepted as a protocol field.',
          scope: 'workspace',
          variables: [],
        },
      }).success,
    ).toBe(false)
  })

  it('requires structured response payloads and typed event variants', () => {
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'changes-list',
        ok: true,
        payload: { kind: 'changes', items: [change] },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'tasks-list',
        ok: true,
        payload: { kind: 'tasks', items: [], response: { raw: 'no' } },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'template-read',
        ok: true,
        payload: {
          kind: 'prompt.template',
          template: {
            summary: {
              templateId: 'template-1',
              title: 'Review',
              description: 'Review the current change.',
              scope: 'global',
              updatedAt: 1_000,
              variables: ['selection'],
              enabled: true,
            },
            templateText: 'Review {{selection}}.',
          },
        },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'template-inserted',
        ok: true,
        payload: {
          kind: 'prompt.template.inserted',
          templateId: 'template-1',
          text: 'Review {{selection}}.',
          unresolvedVariables: ['selection'],
        },
      }).success,
    ).toBe(true)
    expect(
      featureHostEventSchema.safeParse({
        type: 'feature.event',
        name: 'changes.updated',
        identity,
        change,
      }).success,
    ).toBe(true)
    expect(
      featureHostEventSchema.safeParse({
        type: 'feature.event',
        name: 'unknown.event',
        payload: { response: 'raw' },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'context-list',
        ok: true,
        payload: { kind: 'editor.context', items: [contextItem(1)] },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'context-too-many',
        ok: true,
        payload: {
          kind: 'editor.context',
          items: Array.from({ length: 9 }, (_, index) => contextItem(index)),
        },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'context-too-large',
        ok: true,
        payload: {
          kind: 'editor.context',
          items: Array.from({ length: 5 }, (_, index) => contextItem(index, 64 * 1024)),
        },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'prompt.template.insert',
        requestId: 'template-too-many-vars',
        payload: {
          templateId: 'template-1',
          sessionId: 'session-1',
          workspaceFolderId: 'workspace-1',
          variables: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key-${index}`, 'value'])),
        },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'invalid-range',
        ok: true,
        payload: {
          kind: 'editor.context',
          items: [
            { ...contextItem(1), range: { start: { line: 3, column: 0 }, end: { line: 2, column: 0 } } },
          ],
        },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'invalid-rename',
        ok: true,
        payload: {
          kind: 'changes',
          items: [{ ...change, status: 'renamed' }],
        },
      }).success,
    ).toBe(false)
    expect(
      featureWebviewEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: {
          type: 'feature.request.cancel',
          requestId: 'cancel-1',
          payload: { targetRequestId: 'request-1' },
        },
      }).success,
    ).toBe(true)
    expect(
      featureWebviewEnvelopeSchema.safeParse({
        protocolVersion: 2,
        message: {
          type: 'feature.request.cancel',
          requestId: 'cancel-2',
          payload: { targetRequestId: 'request-1' },
        },
      }).success,
    ).toBe(false)
  })

  it('keeps legacy responses compatible with the newly reserved canonical errors', () => {
    expect(
      hostResponseSchema.safeParse({
        type: 'response',
        requestId: 'error-1',
        ok: false,
        error: {
          code: 'RESOURCE_NOT_OWNED',
          message: 'The resource is not owned by this view.',
          retryable: false,
        },
      }).success,
    ).toBe(true)
  })
})
