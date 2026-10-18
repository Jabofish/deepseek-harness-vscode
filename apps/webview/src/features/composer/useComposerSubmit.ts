import { useEffect, useRef, useState } from 'react'
import type { PromptAttachment, RunningInputMode } from '@dsh-vscode/domain'

interface Submission {
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
}

function sameSubmission(left: Submission, right: Submission): boolean {
  return (
    left.draft === right.draft &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((attachment, index) => attachment.uri === right.attachments[index]?.uri)
  )
}

/**
 * The composer's submission latches. `submit` guards the ordinary prompt path
 * (a held-down Enter must not machine-gun sends) and `steerQueuedInputs` the
 * accelerated empty-draft chord; each latch is held until the Host request
 * settles. Synchronous handlers release in the same turn. Only the same draft
 * is latched; a new instruction can be sent while an earlier one waits.
 */
export function useComposerSubmit(props: {
  readonly disabled: boolean
  readonly inputBlocked: boolean
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
  readonly onSubmit: (mode: RunningInputMode) => void | Promise<void>
  readonly onSteerQueue: () => void | Promise<void>
}): {
  readonly isSubmitting: boolean
  readonly submit: (mode: RunningInputMode) => void
  readonly steerQueuedInputs: () => void
} {
  const mounted = useRef(true)
  const submitting = useRef<Submission | undefined>(undefined)
  const [pendingSubmission, setPendingSubmission] = useState<Submission>()
  const steeringQueue = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const submit = (mode: RunningInputMode): void => {
    if (
      props.disabled ||
      props.inputBlocked ||
      (submitting.current !== undefined && sameSubmission(submitting.current, props)) ||
      (props.draft.trim() === '' && props.attachments.length === 0)
    )
      return
    const submissionInput: Submission = { draft: props.draft, attachments: props.attachments }
    submitting.current = submissionInput
    setPendingSubmission(submissionInput)
    const resetSubmitting = (): void => {
      if (submitting.current !== submissionInput) return
      submitting.current = undefined
      if (mounted.current) setPendingSubmission(undefined)
    }
    try {
      const submission = props.onSubmit(mode)
      void Promise.resolve(submission).then(resetSubmitting, resetSubmitting)
    } catch (reason) {
      resetSubmitting()
      throw reason
    }
  }
  const steerQueuedInputs = (): void => {
    if (steeringQueue.current) return
    steeringQueue.current = true
    const resetSteeringQueue = (): void => {
      steeringQueue.current = false
    }
    try {
      const steering = props.onSteerQueue()
      void Promise.resolve(steering).then(resetSteeringQueue, resetSteeringQueue)
    } catch (reason) {
      resetSteeringQueue()
      throw reason
    }
  }
  return {
    isSubmitting: pendingSubmission !== undefined && sameSubmission(pendingSubmission, props),
    submit,
    steerQueuedInputs,
  }
}
