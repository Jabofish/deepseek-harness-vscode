import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { IconName } from '../../ui/Icon.js'
import { Icon } from '../../ui/Icon.js'

export interface CompactPickerOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface CompactPickerProps {
  readonly className?: string
  readonly icon: IconName
  readonly displayLabel?: boolean
  readonly label: string
  readonly ariaLabel: string
  readonly title: string
  readonly value: string
  readonly options: readonly CompactPickerOption[]
  readonly disabled?: boolean
  readonly openRequest?: number
  readonly onChange: (value: string) => void
}

export function CompactPicker(props: CompactPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const className = [
    'dsh-compact-picker',
    props.displayLabel === true ? 'dsh-compact-picker--labelled' : undefined,
    props.className,
  ]
    .filter(Boolean)
    .join(' ')

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !rootRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if ((props.openRequest ?? 0) <= 0 || props.disabled || props.options.length === 0) return
    const openPicker = window.setTimeout(() => {
      setOpen(true)
      // A command can open this picker while focus is still on another picker.
      // Move focus with the popup so the previous control does not keep a stale
      // focus ring beside the newly opened control.
      triggerRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(openPicker)
  }, [props.disabled, props.openRequest, props.options.length])

  return (
    <div ref={rootRef} className={`${className}${open ? ' dsh-compact-picker--open' : ''}`}>
      <button
        ref={triggerRef}
        className="dsh-compact-picker__trigger"
        type="button"
        aria-label={`${props.ariaLabel}: ${props.label}`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`${props.title}: ${props.label}`}
        disabled={props.disabled || props.options.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={props.icon} />
        <span className="dsh-compact-picker__trigger-text">{props.label}</span>
        <span className="dsh-compact-picker__trigger-label">{props.label}</span>
      </button>
      {open ? (
        <div id={listboxId} className="dsh-compact-picker__menu" role="listbox" aria-label={props.ariaLabel}>
          {props.options.map((option) => (
            <button
              className={`dsh-compact-picker__option${
                option.value === props.value ? ' dsh-compact-picker__option--selected' : ''
              }`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return
                props.onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === props.value ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
