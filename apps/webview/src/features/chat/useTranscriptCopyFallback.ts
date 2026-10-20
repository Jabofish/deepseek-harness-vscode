import { useCallback, useEffect, useRef, useState } from 'react'
import { useStableCallback } from '../../app/useStableCallback.js'
import { loadRowCopyMarkdown, rowCopyMarkdown, rowCopyNeedsFullContent } from './transcript-copy.js'
import { writeClipboard } from './clipboard.js'
import type { PresentedTimelineNode } from './focused-timeline-projection.js'

/** Transcript rows publish their projection id here, which is the semantic target. */
const ROW_SELECTOR = '[data-node-id]'
/**
 * Text fields copy their own content: the composer, and the temporary
 * textarea `writeClipboard` selects before its DOM fallback runs.
 */
const FIELD_SELECTOR = 'input, textarea, [contenteditable="true"]'
const ANNOUNCEMENT_MS = 1_000

/**
 * Fills the Webview's own context-menu "Copy" with the row the user addressed.
 *
 * VS Code always enables that entry and runs `document.execCommand('copy')`
 * inside this document, so a collapsed selection copies nothing at all.
 * Intercepting the resulting `copy` event lets the same entry publish the
 * row's Markdown instead, exactly like the row's own copy button.
 *
 * The target is semantic — the focused element, or the element the
 * `contextmenu` event addressed, which is the same node for a mouse
 * right-click, the keyboard menu key and Shift+F10 — never the pointer
 * position, so keyboard users reach the same result.
 *
 * Returns whether the fallback just answered a copy, for a live-region
 * announcement.
 */
export function useTranscriptCopyFallback(
  rows: readonly PresentedTimelineNode[],
  omittedNodeIds: readonly string[] = [],
  loadFullContent?: (id: string) => Promise<string>,
): 'copied' | 'failed' | undefined {
  const rowsRef = useRef(rows)
  /** Row the most recent `contextmenu` addressed, until the user moves on. */
  const contextRowRef = useRef<string | undefined>(undefined)
  const timerRef = useRef<number | undefined>(undefined)
  const [announced, setAnnounced] = useState<'copied' | 'failed'>()
  const copyEpoch = useRef(0)

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  useEffect(
    () => () => {
      copyEpoch.current += 1
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const handleCopy = useStableCallback((event: ClipboardEvent): void => {
    // Another listener already answered this copy.
    if (event.defaultPrevented) return
    // A DOM clipboard fallback raises its own copy event. Let the browser copy
    // that textarea and keep this user gesture's in-flight full-content read.
    if (document.activeElement?.hasAttribute('data-dsh-clipboard-fallback')) return
    const epoch = ++copyEpoch.current
    const clipboard = event.clipboardData
    if (clipboard === null) return
    // A real selection keeps its meaning: the user asked for exactly that text.
    const selection = document.getSelection()
    if (selection !== null && !selection.isCollapsed) return
    // The row a context menu addressed is the user's explicit subject, so it
    // outranks focus: a mouse right-click blurs the transcript, and the
    // keyboard menu key addresses the focused element, so both agree. A copy
    // answers one menu invocation, so the claim is consumed here.
    const addressed = contextRowRef.current
    contextRowRef.current = undefined
    const focused = document.activeElement
    // A focused text field owns its own content — the composer, and the
    // temporary textarea `writeClipboard` selects before its DOM fallback.
    // It vetoes only a copy that no row addressed.
    if (addressed === undefined && focused instanceof Element && focused.closest(FIELD_SELECTOR) !== null) {
      return
    }

    const rowId = addressed ?? rowIdOf(focused)
    const row = rowId === undefined ? undefined : rowsRef.current.find((candidate) => candidate.id === rowId)
    const markdown = row === undefined ? undefined : rowCopyMarkdown(row)
    // A row without readable text stays a strict no-op: leaving the event
    // alone is what keeps an untouched clipboard untouched.
    if (markdown === undefined) return

    const announce = (success: boolean): void => {
      if (epoch !== copyEpoch.current) return
      setAnnounced(success ? 'copied' : 'failed')
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined
        setAnnounced(undefined)
      }, ANNOUNCEMENT_MS)
    }
    const omitted = new Set(omittedNodeIds)
    if (row !== undefined && rowCopyNeedsFullContent(row, omitted)) {
      event.preventDefault()
      if (loadFullContent === undefined) {
        announce(false)
        return
      }
      void loadRowCopyMarkdown(row, omitted, loadFullContent)
        .then(async (content) => {
          if (epoch !== copyEpoch.current) return false
          return content === undefined ? false : writeClipboard(content)
        })
        .then(announce, () => announce(false))
      return
    }

    clipboard.setData('text/plain', markdown)
    event.preventDefault()
    announce(true)
  })

  const recordTarget = useCallback((event: Event): void => {
    contextRowRef.current = event.target instanceof Element ? rowIdOf(event.target) : undefined
  }, [])

  useEffect(() => {
    // A pointer or key press retires the previous menu's claim, so a later
    // keyboard copy can never replay a row the user has already left.
    const forgetTarget = (): void => {
      contextRowRef.current = undefined
    }
    document.addEventListener('contextmenu', recordTarget, true)
    document.addEventListener('pointerdown', forgetTarget, true)
    document.addEventListener('keydown', forgetTarget, true)
    document.addEventListener('copy', handleCopy, true)
    return () => {
      document.removeEventListener('contextmenu', recordTarget, true)
      document.removeEventListener('pointerdown', forgetTarget, true)
      document.removeEventListener('keydown', forgetTarget, true)
      document.removeEventListener('copy', handleCopy, true)
    }
  }, [handleCopy, recordTarget])

  return announced
}

function rowIdOf(element: Element | null): string | undefined {
  if (element === null) return undefined
  return element.closest(ROW_SELECTOR)?.getAttribute('data-node-id') ?? undefined
}
