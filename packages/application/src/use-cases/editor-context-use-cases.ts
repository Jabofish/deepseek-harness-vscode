import type {
  EditorContextAvailability,
  EditorContextCaptureInput,
  EditorContextItem,
  EditorContextOwner,
  EditorContextPreview,
  EditorContextResolveInput,
  ResolvedEditorContext,
} from '@dsh-vscode/domain'

import type { EditorContextPort } from '../ports/feature-ports.js'

export class EditorContextUseCases {
  public constructor(private readonly context: EditorContextPort) {}

  public capture(
    input: EditorContextCaptureInput,
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<EditorContextItem> {
    return this.context.capture(input, owner, signal)
  }

  public list(owner: EditorContextOwner, signal?: AbortSignal): Promise<readonly EditorContextItem[]> {
    return this.context.list(owner, signal)
  }

  public availability(owner: EditorContextOwner, signal?: AbortSignal): Promise<EditorContextAvailability> {
    return this.context.availability(owner, signal)
  }

  public preview(
    contextRef: string,
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<EditorContextPreview> {
    return this.context.preview(contextRef, owner, signal)
  }

  public release(
    contextRefs: readonly string[],
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.context.release(contextRefs, owner, signal)
  }

  public resolveForPrompt(
    input: EditorContextResolveInput,
    signal?: AbortSignal,
  ): Promise<readonly ResolvedEditorContext[]> {
    if (input.contextRefs.length === 0) return Promise.resolve([])
    return this.context.resolveForPrompt(input, signal)
  }
}
