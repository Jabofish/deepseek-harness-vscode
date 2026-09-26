import type { SessionDetail, PromptTemplateSummary } from '@dsh-vscode/domain'
import type { PromptTemplateUseCases } from '@dsh-vscode/application'
import type { FeatureRequest, FeatureResponse } from '@dsh-vscode/webview-protocol'

type PromptTemplateFeatureRequest = Extract<
  FeatureRequest,
  {
    readonly type:
      | 'prompt.template.list'
      | 'prompt.template.read'
      | 'prompt.template.insert'
      | 'prompt.template.create'
      | 'prompt.template.update'
      | 'prompt.template.delete'
  }
>
type FeatureResponsePayload = Extract<FeatureResponse, { readonly ok: true }>['payload']

interface PromptTemplateFeatureDependencies {
  readonly promptTemplateUseCases: PromptTemplateUseCases
  readonly requireCurrentWorkspaceSession: (sessionId: string, signal: AbortSignal) => Promise<SessionDetail>
  readonly featureWorkspaceFolderId: (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ) => string
}

export async function handlePromptTemplateFeatureRequest(
  request: PromptTemplateFeatureRequest,
  signal: AbortSignal,
  dependencies: PromptTemplateFeatureDependencies,
): Promise<unknown> {
  const { promptTemplateUseCases, requireCurrentWorkspaceSession, featureWorkspaceFolderId } = dependencies
  const promptTemplateOwner = async (
    sessionId: string,
    requestedWorkspaceFolderId: string,
    signal: AbortSignal,
  ): Promise<{ readonly sessionId: string; readonly workspaceFolderId: string }> => {
    const session = await requireCurrentWorkspaceSession(sessionId, signal)
    return {
      sessionId: session.id,
      workspaceFolderId: featureWorkspaceFolderId(requestedWorkspaceFolderId, session),
    }
  }
  if (request.type === 'prompt.template.list') {
    const owner = await promptTemplateOwner(
      request.payload.sessionId,
      request.payload.workspaceFolderId,
      signal,
    )
    const templates = await promptTemplateUseCases.list(
      { ...owner, ...(request.payload.scope === undefined ? {} : { scope: request.payload.scope }) },
      signal,
    )
    return { kind: 'prompt.templates', items: templates.map(featurePromptTemplateSummary) }
  }
  if (request.type === 'prompt.template.read') {
    const owner = await promptTemplateOwner(
      request.payload.sessionId,
      request.payload.workspaceFolderId,
      signal,
    )
    const template = await promptTemplateUseCases.read(request.payload.templateId, owner, signal)
    return {
      kind: 'prompt.template',
      template: {
        summary: featurePromptTemplateSummary(template),
        templateText: template.templateText,
      },
    }
  }
  if (request.type === 'prompt.template.insert') {
    const owner = await promptTemplateOwner(
      request.payload.sessionId,
      request.payload.workspaceFolderId,
      signal,
    )
    const inserted = await promptTemplateUseCases.insert(
      request.payload.templateId,
      request.payload.variables,
      owner,
      signal,
    )
    return {
      kind: 'prompt.template.inserted',
      templateId: inserted.templateId,
      text: inserted.text,
      unresolvedVariables: inserted.unresolvedVariables,
    }
  }
  if (request.type === 'prompt.template.create') {
    const owner = await promptTemplateOwner(
      request.payload.sessionId,
      request.payload.workspaceFolderId,
      signal,
    )
    const template = await promptTemplateUseCases.create(
      {
        title: request.payload.title,
        description: request.payload.description,
        templateText: request.payload.templateText,
        scope: request.payload.scope,
        variables: request.payload.variables,
      },
      owner,
      signal,
    )
    return { kind: 'prompt.templates', items: [featurePromptTemplateSummary(template)] }
  }
  if (request.type === 'prompt.template.update') {
    const owner = await promptTemplateOwner(
      request.payload.sessionId,
      request.payload.workspaceFolderId,
      signal,
    )
    const template = await promptTemplateUseCases.update(
      request.payload.templateId,
      {
        ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
        ...(request.payload.description === undefined ? {} : { description: request.payload.description }),
        ...(request.payload.templateText === undefined ? {} : { templateText: request.payload.templateText }),
        ...(request.payload.variables === undefined ? {} : { variables: request.payload.variables }),
      },
      owner,
      signal,
    )
    return { kind: 'prompt.templates', items: [featurePromptTemplateSummary(template)] }
  }
  if (request.type === 'prompt.template.delete') {
    const owner = await promptTemplateOwner(
      request.payload.sessionId,
      request.payload.workspaceFolderId,
      signal,
    )
    await promptTemplateUseCases.delete(request.payload.templateId, owner, signal)
    return {
      kind: 'operation',
      operationId: request.requestId,
      state: 'completed',
      message: 'Prompt template deleted.',
    }
  }
  throw new Error('Unhandled prompt template request')
}

function featurePromptTemplateSummary(
  template: PromptTemplateSummary,
): Extract<FeatureResponsePayload, { readonly kind: 'prompt.templates' }>['items'][number] {
  return {
    templateId: template.templateId,
    title: template.title,
    description: template.description,
    scope: template.scope,
    updatedAt: template.updatedAt,
    variables: [...template.variables],
    enabled: template.enabled,
  }
}
