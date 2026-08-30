import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { IconName } from '../../ui/Icon.js'
import { Icon } from '../../ui/Icon.js'
import { useDismissibleLayer } from './useDismissibleLayer.js'
import { useViewportMenuPosition } from './useViewportMenuPosition.js'

export interface SelectMenuOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectMenuProps {
  readonly className?: string
  readonly icon: IconName
  readonly density?: 'compact' | 'regular'
  readonly displayLabel?: boolean
  readonly label: string
  readonly ariaLabel: string
  readonly title: string
  readonly value: string
  readonly options: readonly SelectMenuOption[]
  readonly disabled?: boolean
  readonly openRequest?: number
  readonly placement?: 'above' | 'below'
  readonly align?: 'start' | 'end'
  readonly onChange: (value: string) => void
}

/**
 * The single-choice surface used by the Webview.
 *
 * A button-backed menu keeps selection surfaces inside the DSH theme on every
 * platform. Native select popups are owned by the operating system and can
 * ignore Webview theme variables entirely, producing an unrelated light menu.
 */
export function SelectMenu(props: SelectMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const enabledOptions = props.options.filter((option) => option.disabled !== true)
  const menuPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef,
    placement: props.placement ?? 'above',
    align: props.align ?? 'end',
    refreshKey: `${props.value}:${props.options.length}`,
  })
  const className = [
    'dsh-select-menu',
    props.density === 'regular' ? 'dsh-select-menu--regular' : undefined,
    props.displayLabel === true ? 'dsh-select-menu--labelled' : undefined,
    props.className,
  ]
    .filter(Boolean)
    .join(' ')

  useDismissibleLayer({
    open,
    refs: [rootRef, menuRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

  useEffect(() => {
    if ((props.openRequest ?? 0) <= 0 || props.disabled || enabledOptions.length === 0) return
    const openPicker = window.setTimeout(() => {
      setActiveIndex(indexOfValue(props.options, props.value))
      setOpen(true)
      triggerRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(openPicker)
  }, [props.disabled, props.openRequest, enabledOptions.length, props.options.length, props.value])

  useEffect(() => {
    if (!open) return
    const nextIndex = clampOptionIndex(props.options, activeIndex, props.value)
    setActiveIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }, [activeIndex, open, props.options, props.value])

  function close(): void {
    setOpen(false)
  }

  function openMenu(nextIndex = indexOfValue(props.options, props.value)): void {
    if (props.disabled || enabledOptions.length === 0) return
    setActiveIndex(nextIndex)
    setOpen(true)
  }

  function focusOption(index: number): void {
    const nextIndex = nextEnabledIndex(props.options, index, 1)
    setActiveIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(
        indexOfValue(props.options, props.value) + (event.key === 'ArrowDown' ? 1 : -1),
      )
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(activeIndex + (event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : props.options.length - 1
      focusOption(index)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = props.options[activeIndex]
      if (option !== undefined && option.disabled !== true) {
        event.preventDefault()
        props.onChange(option.value)
        close()
        triggerRef.current?.focus()
      }
    }
  }

  return (
    <div ref={rootRef} className={`${className}${open ? ' dsh-select-menu--open' : ''}`}>
      <button
        ref={triggerRef}
        className="dsh-select-menu__trigger"
        type="button"
        aria-label={`${props.ariaLabel}: ${props.label}`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`${props.title}: ${props.label}`}
        disabled={props.disabled || props.options.length === 0}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <Icon name={props.icon} />
        <span className="dsh-select-menu__trigger-text">{props.label}</span>
        <span className="dsh-select-menu__trigger-label">{props.label}</span>
        <Icon name="chevron-down" className="dsh-select-menu__chevron" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={listboxId}
          className="dsh-select-menu__menu"
          role="listbox"
          aria-label={props.ariaLabel}
          style={menuPosition}
          onKeyDown={onMenuKeyDown}
        >
          {props.options.map((option, index) => (
            <button
              ref={(element) => {
                optionRefs.current[index] = element
              }}
              className={`dsh-select-menu__option${
                option.value === props.value ? ' dsh-select-menu__option--selected' : ''
              }`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              disabled={option.disabled}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                if (option.disabled) return
                props.onChange(option.value)
                close()
                triggerRef.current?.focus()
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

function indexOfValue(options: readonly SelectMenuOption[], value: string): number {
  const index = options.findIndex((option) => option.value === value && option.disabled !== true)
  return index >= 0 ? index : nextEnabledIndex(options, 0, 1)
}

function clampOptionIndex(
  options: readonly SelectMenuOption[],
  index: number,
  value: string,
): number {
  if (index >= 0 && index < options.length && options[index]?.disabled !== true) return index
  return indexOfValue(options, value)
}

function nextEnabledIndex(options: readonly SelectMenuOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return 0
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset * direction + options.length * 2) % options.length
    if (options[index]?.disabled !== true) return index
  }
  return 0
}
