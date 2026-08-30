import type {
  PromptTemplate,
  PromptTemplateDraft,
  PromptTemplateInsertion,
  PromptTemplateListQuery,
  PromptTemplateOwner,
  PromptTemplateRepository,
  PromptTemplateSummary,
  PromptTemplateUpdate,
} from '@dsh-vscode/domain'

/** Application boundary for local prompt templates; no Webview or filesystem types leak upward. */
export class PromptTemplateUseCases {
  public constructor(private readonly repository: PromptTemplateRepository) {}

  public list(
    query: PromptTemplateListQuery,
    signal?: AbortSignal,
  ): Promise<readonly PromptTemplateSummary[]> {
    return this.repository.list(query, signal)
  }

  public read(templateId: string, owner: PromptTemplateOwner, signal?: AbortSignal): Promise<PromptTemplate> {
    return this.repository.read(templateId, owner, signal)
  }

  public insert(
    templateId: string,
    variables: Readonly<Record<string, string>> | undefined,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateInsertion> {
    return this.repository.insert(templateId, variables, owner, signal)
  }

  public create(
    draft: PromptTemplateDraft,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateSummary> {
    return this.repository.create(draft, owner, signal)
  }

  public update(
    templateId: string,
    patch: PromptTemplateUpdate,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateSummary> {
    return this.repository.update(templateId, patch, owner, signal)
  }

  public delete(templateId: string, owner: PromptTemplateOwner, signal?: AbortSignal): Promise<void> {
    return this.repository.delete(templateId, owner, signal)
  }
}
