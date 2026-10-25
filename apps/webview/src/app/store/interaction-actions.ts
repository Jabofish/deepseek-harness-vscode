import { translate } from '../../i18n.js'
import type { QuestionSettlements, UserQuestion, QuestionRequestIdentity } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import {
  attachmentFromResult,
  imageDataUri,
  mergeEditorContext,
  openFileCandidatesFromResult,
  parseEditorContextItems,
} from './editor-context.js'
import { referenceCandidates } from './references.js'
import { questionResponsePayload } from './session-guards.js'
import { object } from './unknown-record.js'
import type { AppActions, AppState, StateSetter } from './types.js'

export type InteractionActionMethods = Pick<
  AppActions,
  | 'listReferences'
  | 'respondToPermission'
  | 'respondToQuestion'
  | 'cancelQuestion'
  | 'pickAttachment'
  | 'ingestAttachment'
  | 'previewAttachment'
  | 'readSessionAttachment'
  | 'releaseAttachments'
  | 'listOpenFiles'
  | 'attachOpenFile'
  | 'openLink'
  | 'showInFolder'
>

export function createInteractionActions(
  client: ProtocolClient,
  setState: StateSetter,
  getState: () => AppState,
  settlements: QuestionSettlements,
): InteractionActionMethods {
  const pendingQuestion = (id: string, identity?: QuestionRequestIdentity): UserQuestion | undefined => {
    const matches = getState().questions.filter(
      (question) =>
        (question.id === id || question.items?.some((item) => item.id === id)) &&
        (identity === undefined ||
          (question.sessionId === identity.sessionId && question.rpcId === identity.rpcId)),
    )
    return matches.length === 1 ? matches[0] : undefined
  }
  const settle = (question: UserQuestion | undefined, epoch: number | undefined): void => {
    if (question === undefined || getState().connectionEpoch !== epoch) return
    settlements.accept(question)
    setState((current) => ({
      ...current,
      questions: current.questions.filter((item) => !settlements.has(item)),
    }))
  }
  return {
    listReferences: async (sessionId, query, quoted) => {
      const result = await client.request<unknown>({
        type: 'reference.list',
        requestId: requestId(),
        payload: { sessionId, query, quoted },
      })
      return referenceCandidates(result)
    },
    respondToPermission: (interactionId, optionId) =>
      client
        .request<unknown>({
          type: 'interaction.permission.respond',
          requestId: requestId(),
          payload: { interactionId, optionId },
        })
        .then(() =>
          setState((current) => ({
            ...current,
            permissions: current.permissions.filter((item) => item.id !== interactionId),
          })),
        ),
    respondToQuestion: (questionId, response, identity) => {
      const question = pendingQuestion(questionId, identity)
      const requestIdentity =
        identity ??
        (question?.rpcId === undefined ? undefined : { sessionId: question.sessionId, rpcId: question.rpcId })
      const epoch = getState().connectionEpoch
      return client
        .request<unknown>({
          type: 'interaction.question.respond',
          requestId: requestId(),
          payload: {
            questionId,
            ...(requestIdentity === undefined ? {} : { identity: requestIdentity }),
            response: questionResponsePayload(response),
          },
        })
        .then(() => settle(question, epoch))
    },
    cancelQuestion: (questionId, identity) => {
      const question = pendingQuestion(questionId, identity)
      const requestIdentity =
        identity ??
        (question?.rpcId === undefined ? undefined : { sessionId: question.sessionId, rpcId: question.rpcId })
      const epoch = getState().connectionEpoch
      return client
        .request<unknown>({
          type: 'interaction.question.cancel',
          requestId: requestId(),
          payload: { questionId, ...(requestIdentity === undefined ? {} : { identity: requestIdentity }) },
        })
        .then(() => settle(question, epoch))
    },
    pickAttachment: async () => {
      return attachmentFromResult(
        await client.request<unknown>({ type: 'attachment.pick', requestId: requestId() }),
      )
    },
    ingestAttachment: async (input) => {
      return attachmentFromResult(
        await client.request<unknown>({
          type: 'attachment.ingest',
          requestId: requestId(),
          payload: {
            name: input.name,
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            dataBase64: input.dataBase64,
          },
        }),
      )
    },
    previewAttachment: async (uri) => {
      const result = object(
        await client.request<unknown>({
          type: 'attachment.preview',
          requestId: requestId(),
          payload: { uri },
        }),
      )
      if (result?.cancelled === true || typeof result?.dataUri !== 'string') return undefined
      return result.dataUri
    },
    readSessionAttachment: async (sessionId, image) => {
      const result = object(
        await client.request<unknown>({
          type: 'attachment.read',
          requestId: requestId(),
          payload: { sessionId, attachmentId: image.attachmentId },
        }),
      )
      if (result?.cancelled === true) return undefined
      const direct = imageDataUri(result?.dataUri)
      if (direct !== undefined) return direct
      const handle = object(result?.attachment)?.uri
      if (typeof handle !== 'string' || handle.trim() === '') return undefined
      try {
        const preview = object(
          await client.request<unknown>({
            type: 'attachment.preview',
            requestId: requestId(),
            payload: { uri: handle },
          }),
        )
        return imageDataUri(preview?.dataUri)
      } finally {
        await client
          .request<unknown>({
            type: 'attachment.release',
            requestId: requestId(),
            payload: { uris: [handle] },
          })
          .catch(() => undefined)
      }
    },
    releaseAttachments: async (uris) => {
      if (uris.length === 0) return
      await client.request<unknown>({
        type: 'attachment.release',
        requestId: requestId(),
        payload: { uris: [...uris] },
      })
    },
    listOpenFiles: async () => {
      return openFileCandidatesFromResult(
        await client.request<unknown>({ type: 'attachment.open.list', requestId: requestId() }),
      )
    },
    attachOpenFile: async (candidateId, isCurrent) => {
      const result = object(
        await client.request<unknown>({
          type: 'attachment.open.attach',
          requestId: requestId(),
          payload: { candidateId },
        }),
      )
      if (result?.kind === 'editor.context') {
        const items = parseEditorContextItems(result.items)
        const item = items?.[0]
        if (items?.length !== 1 || item === undefined)
          throw new Error(translate('app.error.attachSelectedFile'))
        if (!isCurrent()) {
          await client
            .featureRequest?.({
              type: 'editor.context.release',
              requestId: requestId(),
              payload: {
                contextRefs: [item.ref.contextRef],
                workspaceFolderId: item.ref.workspaceFolderId,
              },
            })
            .catch(() => undefined)
          return undefined
        }
        setState((current) => ({
          ...current,
          editorContext: mergeEditorContext(current.editorContext, items),
        }))
        return { kind: 'context', contextRef: item.ref.contextRef }
      }
      return attachmentFromResult(result)
    },
    openLink: async (href) => {
      const result = object(
        await client.request<unknown>({
          type: 'view.openLink',
          requestId: requestId(),
          payload: { href },
        }),
      )
      if (result?.opened === true) return
      throw new Error(typeof result?.message === 'string' ? result.message : translate('app.error.openLink'))
    },
    showInFolder: async (href) => {
      const result = object(
        await client.request<unknown>({
          type: 'view.showInFolder',
          requestId: requestId(),
          payload: { href },
        }),
      )
      if (result?.opened === true) return
      throw new Error(typeof result?.message === 'string' ? result.message : translate('app.error.openLink'))
    },
  }
}
