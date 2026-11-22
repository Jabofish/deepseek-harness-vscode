import { useEffect } from 'react'

/**
 * Report this Webview's renderer focus to the Host. The Host needs every
 * visible chat showing a session, not only the panel whose render receipt
 * happens to arrive first, to decide whether a completion cue is wanted.
 */
export function useSurfaceFocusReport(report: (focused: boolean) => Promise<void>): void {
  useEffect(() => {
    let active = true
    const send = (): void => {
      if (!active) return
      void report(document.hasFocus()).catch(() => undefined)
    }
    send()
    window.addEventListener('focus', send)
    window.addEventListener('blur', send)
    return () => {
      active = false
      window.removeEventListener('focus', send)
      window.removeEventListener('blur', send)
    }
  }, [report])
}
