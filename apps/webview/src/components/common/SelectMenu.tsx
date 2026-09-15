import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
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
  /** Overlay menus escape nearby layout; flow menus reserve room in forms. */
  readonly menuMode?: 'overlay' | 'flow'
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
export const SelectMenu = memo(function SelectMenu(props: SelectMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  /**
   * Requests are one-shot: the counter stays above zero for the rest of the
   * session, so a value seen at mount is already spent and a remount must not
   * spend it again.
   */
  const consumedRequestRef = useRef(props.openRequest ?? 0)
  const enabledOptions = props.options.filter((option) => option.disabled !== true)
  const menuMode = props.menuMode ?? 'overlay'
  const menuPosition = useViewportMenuPosition({
    open: open && menuMode === 'overlay',
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
    menuMode === 'flow' ? 'dsh-select-menu--flow' : undefined,
    props.className,
  ]
    .filter(Boolean)
    .join(' ')
  const requestedIndex = indexOfValue(props.options, props.value)
  const activeOptionIndex = clampOptionIndex(props.options, activeIndex, props.value)

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
    const request = props.openRequest ?? 0
    if (request <= 0 || request <= consumedRequestRef.current) return
    // An empty option list is the one transient reason to keep waiting: the
    // request is spent only once there is something to show.
    if (props.disabled || enabledOptions.length === 0) return
    const openPicker = window.setTimeout(() => {
      consumedRequestRef.current = request
      setActiveIndex(requestedIndex)
      setOpen(true)
      triggerRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(openPicker)
  }, [enabledOptions.length, props.disabled, props.openRequest, requestedIndex])

  useEffect(() => {
    if (!open) return
    optionRefs.current[activeOptionIndex]?.focus()
  }, [activeOptionIndex, open])

  function close(): void {
    setOpen(false)
  }

  function openMenu(nextIndex = indexOfValue(props.options, props.value), direction: 1 | -1 = 1): void {
    if (props.disabled || enabledOptions.length === 0) return
    // A disabled entry cannot take focus, so the requested neighbour would
    // leave the menu open but unfocused, with the keyboard stuck on the trigger.
    setActiveIndex(nextEnabledIndex(props.options, nextIndex, direction))
    setOpen(true)
  }

  function focusOption(index: number, direction: 1 | -1): void {
    const nextIndex = nextEnabledIndex(props.options, index, direction)
    setActiveIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      openMenu(indexOfValue(props.options, props.value) + direction, direction)
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
      const direction = event.key === 'ArrowDown' ? 1 : -1
      focusOption(activeOptionIndex + direction, direction)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const toStart = event.key === 'Home'
      focusOption(toStart ? 0 : props.options.length - 1, toStart ? 1 : -1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = props.options[activeOptionIndex]
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
          style={menuMode === 'overlay' ? menuPosition : undefined}
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
              tabIndex={index === activeOptionIndex ? 0 : -1}
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
})

function indexOfValue(options: readonly SelectMenuOption[], value: string): number {
  const index = options.findIndex((option) => option.value === value && option.disabled !== true)
  return index >= 0 ? index : nextEnabledIndex(options, 0, 1)
}

function clampOptionIndex(options: readonly SelectMenuOption[], index: number, value: string): number {
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
