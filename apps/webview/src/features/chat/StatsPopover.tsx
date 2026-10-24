import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'
import { useI18n } from '../../i18n.js'
import { Icon, type IconName } from '../../ui/Icon.js'

/** A quiet reading with a separate, bounded detail surface, as in DSH's StatsPills. */
export function StatsPopover(props: {
  readonly label: string
  readonly labelSuffix?: ReactNode
  readonly icon: IconName
  readonly rows: readonly { readonly label: string; readonly value: string }[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly children?: ReactNode
}): ReactElement {
  const { t } = useI18n()
  const id = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useViewportMenuPosition({ open: props.open, anchorRef, menuRef: panelRef })
  useDismissibleLayer({
    open: props.open,
    refs: [anchorRef, panelRef],
    onDismiss: () => props.onOpenChange(false),
    onEscape: () => {
      props.onOpenChange(false)
      anchorRef.current?.focus()
    },
  })
  useEffect(() => {
    if (!props.open) return
    const panel = panelRef.current
    const anchor = anchorRef.current
    panel?.focus()
    return () => {
      if (panel?.contains(document.activeElement)) anchor?.focus()
    }
  }, [props.open])
  if (props.rows.length === 0 && props.children == null)
    return (
      <span className="dsh-stats-pill">
        <Icon name={props.icon} />
        <span>{props.label}</span>
      </span>
    )
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="dsh-stats-pill"
        aria-label={`${t('stats.details')}: ${props.label}`}
        aria-describedby={props.labelSuffix == null ? undefined : `${id}-suffix`}
        aria-haspopup="dialog"
        aria-expanded={props.open}
        aria-controls={props.open ? id : undefined}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Icon name={props.icon} />
        <span>{props.label}</span>
        {props.labelSuffix == null ? null : (
          <span className="dsh-stats-pill__suffix" id={`${id}-suffix`}>
            {props.labelSuffix}
          </span>
        )}
      </button>
      {props.open
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              className="dsh-stats-dialog"
              style={position}
              role="dialog"
              aria-label={t('stats.details')}
              tabIndex={0}
            >
              <strong>{t('stats.details')}</strong>
              {props.rows.length === 0 ? null : (
                <dl>
                  {props.rows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {props.children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
