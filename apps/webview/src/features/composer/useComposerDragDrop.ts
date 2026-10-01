import { useEffect, useRef, useState, type DragEvent } from 'react'

/**
 * Attachment drag & drop: the window-level readiness listeners (a drag may
 * start anywhere) and the form-level enter/over/leave/drop handlers. The
 * overlay state is `blocked` when the composer or its attachments are
 * disabled, `ready` while files hover, and cleared once the drag ends.
 */
export function useComposerDragDrop(props: {
  readonly disabled: boolean
  readonly attachmentsDisabled: boolean
  readonly ingestFiles: (files: readonly File[] | FileList) => void
}): {
  readonly dragging: boolean
  readonly dropState: 'ready' | 'blocked' | undefined
  readonly onDragEnter: (event: DragEvent<HTMLFormElement>) => void
  readonly onDragOver: (event: DragEvent<HTMLFormElement>) => void
  readonly onDragLeave: () => void
  readonly onDrop: (event: DragEvent<HTMLFormElement>) => void
} {
  const { disabled, attachmentsDisabled, ingestFiles } = props
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [dropState, setDropState] = useState<'ready' | 'blocked' | undefined>(undefined)
  useEffect(() => {
    const hasFiles = (event: globalThis.DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDropState(disabled || attachmentsDisabled ? 'blocked' : 'ready')
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (event.relatedTarget === null) setDropState(undefined)
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDropState(undefined)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [attachmentsDisabled, disabled])
  const onDragEnter = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (disabled || attachmentsDisabled) {
      setDropState('blocked')
      return
    }
    dragDepth.current += 1
    setDragging(true)
    setDropState('ready')
  }
  const onDragOver = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (disabled || attachmentsDisabled) setDropState('blocked')
  }
  const onDragLeave = (): void => {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (disabled || attachmentsDisabled) {
      setDropState(undefined)
      return
    }
    setDropState(undefined)
    ingestFiles(event.dataTransfer.files)
  }
  return { dragging, dropState, onDragEnter, onDragOver, onDragLeave, onDrop }
}
