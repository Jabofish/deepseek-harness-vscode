import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'

import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { SchedulePanel } from './SchedulePanel.js'
import './schedule-drawer.css'

export interface ScheduleDrawerProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly featureRequest: <T>(request: FeatureRequest) => Promise<T>
  readonly subscribeFeature: (listener: (message: FeatureHostEvent) => void) => () => void
  readonly onStartScheduleSession: () => void | Promise<void>
}

export function ScheduleDrawer(props: ScheduleDrawerProps): ReactElement | null {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useDismissibleLayer({ open: props.open, refs: [dialogRef], onDismiss: props.onClose })

  useEffect(() => {
    if (!props.open) return
    const activeElement = document.activeElement
    const returnFocus = activeElement instanceof HTMLElement ? activeElement : undefined
    closeRef.current?.focus()
    return () => {
      if (returnFocus?.isConnected === true) returnFocus.focus()
    }
  }, [props.open])

  const trapTab = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.getAttribute('aria-hidden') !== 'true')
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) {
      event.preventDefault()
      closeRef.current?.focus()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!props.open) return null

  return (
    <div className="dsh-schedule-drawer__backdrop">
      <div
        ref={dialogRef}
        className="dsh-schedule-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('schedules.title')}
        onKeyDown={trapTab}
      >
        <button
          ref={closeRef}
          className="dsh-icon-button dsh-schedule-drawer__close"
          type="button"
          aria-label={t('schedules.close')}
          title={t('schedules.close')}
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
        <div className="dsh-schedule-drawer__content">
          <SchedulePanel
            featureRequest={props.featureRequest}
            subscribeFeature={props.subscribeFeature}
            onStartScheduleSession={props.onStartScheduleSession}
          />
        </div>
      </div>
    </div>
  )
}
