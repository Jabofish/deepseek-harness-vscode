import type { ReactElement, ReactNode } from 'react'
import { Stack, Surface } from './Layout.js'

export interface SettingCardProps {
  readonly title?: ReactNode
  readonly description?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly ariaLabel?: string
}

/** A themed section surface used by settings and other configuration views. */
export function SettingCard(props: SettingCardProps): ReactElement {
  return (
    <Surface
      as="section"
      className={`dsh-setting-card${props.className === undefined ? '' : ` ${props.className}`}`}
      {...(props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel })}
    >
      {props.title === undefined && props.description === undefined ? null : (
        <header className="dsh-setting-card__header">
          {props.title === undefined ? null : <h3 className="dsh-setting-card__title">{props.title}</h3>}
          {props.description === undefined ? null : (
            <p className="dsh-setting-card__description">{props.description}</p>
          )}
        </header>
      )}
      <Stack className="dsh-setting-card__body" gap="md">
        {props.children}
      </Stack>
    </Surface>
  )
}

export interface SettingRowProps {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly control: ReactNode
  readonly footer?: ReactNode
  readonly status?: ReactNode
  readonly className?: string
  readonly as?: 'div' | 'li'
}

/** A two-column setting row with copy on the left and the control on the right. */
export function SettingRow(props: SettingRowProps): ReactElement {
  const Row = props.as === 'li' ? 'li' : 'div'
  return (
    <Row
      className={`dsh-setting-row${props.className === undefined ? '' : ` ${props.className}`}`}
      data-component="setting-row"
    >
      <div className="dsh-setting-row__layout">
        <div className="dsh-setting-row__copy">
          <div className="dsh-setting-row__title-line">
            <strong className="dsh-setting-row__title">{props.title}</strong>
            {props.status === undefined ? null : (
              <span className="dsh-setting-row__status">{props.status}</span>
            )}
          </div>
          {props.description === undefined ? null : (
            <p className="dsh-setting-row__description">{props.description}</p>
          )}
        </div>
        <div className="dsh-setting-row__control">{props.control}</div>
      </div>
      {props.footer === undefined ? null : <div className="dsh-setting-row__footer">{props.footer}</div>}
    </Row>
  )
}
