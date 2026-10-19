import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { isEditorCompanionResult } from '@dsh-vscode/domain'

export function registerEditorRemote(ctx: Context, methods: readonly InvocationDescriptor[]): void {
  const registry = ctx.typert
  if (!hasRegistration(registry)) throw new Error('The DSH reflection registry is unavailable.')
  registry.register({
    package: '@dsh-vscode/editor-bridge',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [...methods],
  })
}
function hasRegistration(value: object): value is { register(contribution: TypertContribution): () => void } {
  return 'register' in value && typeof value.register === 'function'
}
export function editorDescriptor<T>(
  namespace: string,
  method: string,
  input: z.ZodType,
  accepts: (value: unknown) => value is T,
): InvocationDescriptor {
  return {
    id: `@dsh-vscode/editor-bridge#${namespace}/${method}`,
    namespace,
    service: namespace,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: method, create: () => input },
      },
    ],
    ...(method === 'poll' ? { cancellation: { parameter: 'signal' as const } } : {}),
    result: {
      mode: 'strict',
      typeSymbol: `${method}Result`,
      create: () => z.custom((value) => isEditorCompanionResult(value, accepts)),
    },
  }
}
