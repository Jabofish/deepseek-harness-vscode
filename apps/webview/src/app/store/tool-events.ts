import { isRecord } from './unknown-record.js'
import {
  parseToolPresentation,
  parsePresentedFiles,
  parseToolLocations,
  parseToolAutoReviewDenial,
  presentationIdentifier,
  positivePresentationNumber,
} from './tool-presentation.js'
import { finiteEventIndex, isToolStatus, messageImages, nonEmptyString } from './event-values.js'

import type { BackendEvent } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseToolEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | undefined {
  if (name === 'deliverables.presented' && nonEmptyString(value.sessionId)) {
    const turn = positivePresentationNumber(value.turn)
    const callId = presentationIdentifier(value.callId)
    const files = parsePresentedFiles(value.files)
    if (turn !== undefined && callId !== undefined && files !== undefined)
      return {
        type: 'deliverables.presented',
        sessionId: value.sessionId,
        turn,
        callId,
        files,
      }
  }
  if (
    name === 'tool.updated' &&
    nonEmptyString(value.sessionId) &&
    isRecord(value.tool) &&
    typeof value.tool.id === 'string' &&
    value.tool.id.trim() !== '' &&
    typeof value.tool.name === 'string' &&
    value.tool.name.trim() !== '' &&
    isToolStatus(value.tool.status)
  ) {
    const turn = finiteEventIndex(value.tool.turn)
    const step = finiteEventIndex(value.tool.step)
    const parentCallId = value.tool.parentCallId
    const locations = parseToolLocations(value.tool.locations)
    const presentation = parseToolPresentation(value.tool.presentation)
    const autoReviewDenial = parseToolAutoReviewDenial(value.tool.autoReviewDenial)
    const images = value.tool.images === undefined ? undefined : messageImages(value.tool.images)
    if (
      (value.tool.images !== undefined && images === undefined) ||
      (value.tool.turn !== undefined && turn === undefined) ||
      (value.tool.step !== undefined && step === undefined) ||
      (parentCallId !== undefined && !nonEmptyString(parentCallId)) ||
      (value.tool.category !== undefined && typeof value.tool.category !== 'string') ||
      (value.tool.title !== undefined && typeof value.tool.title !== 'string') ||
      (value.tool.startedAt !== undefined && typeof value.tool.startedAt !== 'string') ||
      (value.tool.completedAt !== undefined && typeof value.tool.completedAt !== 'string') ||
      (value.tool.inputSummary !== undefined && typeof value.tool.inputSummary !== 'string') ||
      (value.tool.outputSummary !== undefined && typeof value.tool.outputSummary !== 'string') ||
      (value.tool.error !== undefined && typeof value.tool.error !== 'string') ||
      (value.tool.autoReviewDenial !== undefined && autoReviewDenial === undefined) ||
      (autoReviewDenial !== undefined && value.tool.status !== 'failed') ||
      (value.tool.metadata !== undefined && !isRecord(value.tool.metadata))
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'tool.updated',
      sessionId: value.sessionId,
      tool: {
        id: value.tool.id,
        ...(typeof parentCallId === 'string' ? { parentCallId } : {}),
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        name: value.tool.name,
        category: typeof value.tool.category === 'string' ? value.tool.category : 'tool',
        title: typeof value.tool.title === 'string' ? value.tool.title : value.tool.name,
        status: value.tool.status,
        ...(typeof value.tool.startedAt === 'string' ? { startedAt: value.tool.startedAt } : {}),
        ...(typeof value.tool.completedAt === 'string' ? { completedAt: value.tool.completedAt } : {}),
        ...(isRecord(value.tool.submittedPlan) &&
        typeof value.tool.submittedPlan.title === 'string' &&
        typeof value.tool.submittedPlan.markdown === 'string'
          ? {
              submittedPlan: {
                title: value.tool.submittedPlan.title,
                markdown: value.tool.submittedPlan.markdown,
              },
            }
          : {}),
        ...(typeof value.tool.inputSummary === 'string' ? { inputSummary: value.tool.inputSummary } : {}),
        ...(typeof value.tool.outputSummary === 'string' ? { outputSummary: value.tool.outputSummary } : {}),
        ...(typeof value.tool.error === 'string' ? { error: value.tool.error } : {}),
        ...(autoReviewDenial === undefined ? {} : { autoReviewDenial }),
        ...(locations === undefined ? {} : { locations }),
        ...(presentation === undefined ? {} : { presentation }),
        ...(images === undefined ? {} : { images }),
        metadata: isRecord(value.tool.metadata) ? value.tool.metadata : {},
      },
    }
  }
  return undefined
}
