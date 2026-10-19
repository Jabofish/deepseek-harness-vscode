import { useEffect, useRef, useState } from 'react'
import type { PromptAttachment, RunningInputMode } from '@dsh-vscode/domain'

interface Submission {
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
  readonly controller?: AbortController
  readonly direct: boolean
}

/**
 * The composer's submission latches. `submit` guards the ordinary prompt path
 * (a held-down Enter must not machine-gun sends) and `steerQueuedInputs` the
 * accelerated empty-draft chord; each latch is held until the Host request
 * settles. Synchronous handlers release in the same turn. One admission at a time;
 * changing the draft does not dismiss the sending indicator.
 */
export function useComposerSubmit(props: {
  readonly disabled: boolean
  readonly inputBlocked: boolean
  readonly running?: boolean
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
  readonly onSubmit: (mode: RunningInputMode, signal?: AbortSignal) => void | Promise<void>
  readonly onSteerQueue: () => void | Promise<void>
}): {
  readonly isSubmitting: boolean
  readonly isDirectSubmitting: boolean
  readonly cancelSubmission: () => void
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
      submitting.current !== undefined ||
      (props.draft.trim() === '' && props.attachments.length === 0)
    )
      return
    const submissionInput: Submission = {
      draft: props.draft,
      attachments: props.attachments,
      controller: new AbortController(),
      direct: props.running !== true,
    }
    submitting.current = submissionInput
    setPendingSubmission(submissionInput)
    const resetSubmitting = (): void => {
      if (submitting.current !== submissionInput) return
      submitting.current = undefined
      if (mounted.current) setPendingSubmission(undefined)
    }
    try {
      const submission = props.onSubmit(mode, submissionInput.controller?.signal)
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
    isSubmitting: pendingSubmission !== undefined,
    isDirectSubmitting: pendingSubmission?.direct === true,
    cancelSubmission: () => submitting.current?.controller?.abort(),
    submit,
    steerQueuedInputs,
  }
}
