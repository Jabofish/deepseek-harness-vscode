import { AppError, type QuestionAnswer } from '@dsh-vscode/domain'

export function sessionOpenFailure(stage: string, error: unknown): AppError {
  const source = error instanceof AppError ? error : undefined
  return new AppError({
    code: source?.code ?? 'INTERNAL_ERROR',
    message: `Opening the DSH session failed during ${stage}.`,
    retryable: source?.retryable ?? true,
    cause: error,
    context: {
      operation: 'session.open',
      stage,
      ...(source?.context?.rpcMethod === undefined ? {} : { rpcMethod: source.context.rpcMethod }),
      ...(source?.context?.rpcCode === undefined ? {} : { rpcCode: source.context.rpcCode }),
    },
  })
}
/** Zod-inferred optional fields carry `| undefined`; the domain's
 * exactOptionalPropertyTypes contracts require it stripped before the
 * parsed payload reaches application use cases. */
export function questionResponse(
  response:
    | string
    | readonly string[]
    | readonly {
        readonly id: string
        readonly response: string | string[]
        readonly custom?: string | undefined
      }[],
): string | readonly string[] | readonly QuestionAnswer[] {
  if (typeof response === 'string') return response
  const labels: string[] = []
  const answers: QuestionAnswer[] = []
  for (const entry of response) {
    if (typeof entry === 'string') labels.push(entry)
    else
      answers.push({
        id: entry.id,
        response: entry.response,
        ...(entry.custom === undefined ? {} : { custom: entry.custom }),
      })
  }
  return answers.length > 0 ? answers : labels
}
