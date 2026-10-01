import { useEffect, useMemo, useRef, useState } from 'react'
import type { PromptAttachment } from '@dsh-vscode/domain'

/**
 * The attachment preview lightbox: which thumbnail is open, the settled
 * attachment behind it, and the keyboard hand-off — the lightbox is
 * `aria-modal`, so the keyboard belongs inside while it is up and returns to
 * the thumbnail that opened it. The opener is captured at the click site
 * rather than from the effect, because the lightbox mounts with its own
 * `autoFocus`.
 */
export function useAttachmentLightbox(attachments: readonly PromptAttachment[]): {
  readonly previewUri: string | undefined
  readonly previewedAttachment: PromptAttachment | undefined
  readonly openPreview: (uri: string, trigger: HTMLButtonElement) => void
  readonly closePreview: () => void
} {
  const [previewUri, setPreviewUri] = useState<string | undefined>(undefined)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const previewWasOpen = useRef(false)
  useEffect(() => {
    if (previewWasOpen.current && previewUri === undefined) {
      const target = previewTriggerRef.current
      previewTriggerRef.current = null
      // A removed attachment takes its thumbnail away; body focus beats a
      // detached node.
      if (target !== null && target.isConnected) target.focus()
    }
    previewWasOpen.current = previewUri !== undefined
  }, [previewUri])
  const previewedAttachment = useMemo(
    () => (previewUri === undefined ? undefined : attachments.find((item) => item.uri === previewUri)),
    [previewUri, attachments],
  )
  const openPreview = (uri: string, trigger: HTMLButtonElement): void => {
    previewTriggerRef.current = trigger
    setPreviewUri(uri)
  }
  const closePreview = (): void => setPreviewUri(undefined)
  return { previewUri, previewedAttachment, openPreview, closePreview }
}
