import { AppError, type BackendEvent } from '@dsh-vscode/domain'
import { normalizeEnvelope } from '../../stream-envelopes.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'

/** Fixed approval actions use the existing single-choice question surface.
 * Browser subject icons and display dictionaries supply no authority and stay private.
 */
export function normalizeAlpha222GlobalEvent(value: unknown): BackendEvent | undefined {
  const envelope = recordOrUndefined(value)
  const frame = recordOrUndefined(envelope?.payload ?? value)
  const questions = frame?.questions
  if (frame?.type !== 'question/requested' || !Array.isArray(questions)) return normalizeEnvelope(value)
  const approvals = questions.filter(
    (q: unknown) => recordOrUndefined(recordOrUndefined(q)?.intent)?.kind === 'approval',
  )
  if (approvals.length === 0) return normalizeEnvelope(value)
  const question = recordOrUndefined(approvals[0])!
  const intent = recordOrUndefined(question.intent)!
  const labels = [intent.approve, intent.reject, ...(intent.always === undefined ? [] : [intent.always])]
  const options = question.options
  if (
    questions.length !== 1 ||
    frame.wait !== undefined ||
    question.multiSelect === true ||
    typeof question.detail !== 'string' ||
    !Array.isArray(options) ||
    options.length !== labels.length ||
    labels.some((label) => typeof label !== 'string' || label.trim() === '') ||
    new Set(labels).size !== labels.length ||
    !labels.every((label) => options.some((option: unknown) => recordOrUndefined(option)?.label === label))
  )
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'Invalid blocking approval question.',
      retryable: false,
    })
  const { intent: _intent, ...plainQuestion } = question
  void _intent
  const plainFrame = { ...frame, questions: [plainQuestion] }
  const event = normalizeEnvelope(
    envelope?.payload === undefined ? plainFrame : { ...envelope, payload: plainFrame },
  )
  if (event?.type !== 'question.requested')
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'Invalid blocking approval question.',
      retryable: false,
    })
  return {
    ...event,
    question: {
      ...event.question,
      multiSelect: false,
      allowFreeText: false,
      ...(event.question.items === undefined
        ? {}
        : {
            items: event.question.items.map((item) => ({
              ...item,
              multiSelect: false,
              allowFreeText: false,
            })),
          }),
    },
  }
}
