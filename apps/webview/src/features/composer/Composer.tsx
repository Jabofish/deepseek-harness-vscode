import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type {
  AgentConfiguration,
  AgentPresetDescriptor,
  ContextBreakdown,
  DynamicCommand,
  ImageAttachmentLimits,
  ModelDescriptor,
  PromptAttachment,
  QueuedInput,
  RunningInputMode,
} from '@dsh-vscode/domain'
import type { OpenFileCandidate, ReferenceCandidate } from '../../app/store.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { AttachmentLightbox } from '../attachments/AttachmentLightbox.js'
import {
  COMMAND_MENU_ID,
  CommandPalette,
  commandMenuOptionId,
  commandMenuRows,
  firstCommandPaletteSelection,
  type CommandArgumentOption,
  type CommandMenuRow,
  type CommandPaletteSelection,
} from '../commands/CommandPalette.js'
import { commandDispatchKind, type PopupSelectRegistry } from '../commands/popupSelectRegistry.js'
import { formatPermissionLabel, permissionOptions, SessionControls } from './SessionControls.js'
import { REFERENCE_MENU_ID, ReferencePalette, referenceMenuOptionId } from './ReferencePalette.js'

const COMPOSER_MIN_HEIGHT = 42
const COMPOSER_MAX_HEIGHT = 132

export interface ComposerProps {
  readonly disabled: boolean
  /** Disable human input while leaving an active turn's Stop action enabled. */
  readonly inputDisabled?: boolean
  /** The pinned subagent continuation contract accepts text only. */
  readonly attachmentsDisabled?: boolean
  readonly running: boolean
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
  /** Optional DSH `imageLimits` projection; absent on older/partial hosts. */
  readonly imageLimits?: ImageAttachmentLimits
  readonly configuration?: AgentConfiguration | undefined
  readonly models?: readonly ModelDescriptor[]
  readonly presets?: readonly AgentPresetDescriptor[]
  readonly permissionPresets?: readonly string[]
  readonly commands?: readonly DynamicCommand[]
  /** Client-owned bare-command popup decorations; host rows remain authoritative. */
  readonly popupSelects?: PopupSelectRegistry
  /** Host-backed DSH `@` file/session reference candidates. */
  readonly references?: readonly ReferenceCandidate[]
  readonly referenceLoading?: boolean
  readonly modelPickerOpenRequest?: number
  readonly estimatedContextTokens?: number
  readonly contextWindowTokens?: number
  readonly contextBreakdown?: ContextBreakdown
  readonly configurationDisabled?: boolean
  readonly presetMutable?: boolean
  readonly attachmentPreviews?: Readonly<Record<string, string>>
  readonly onConfigurationChange?: (configuration: AgentConfiguration) => void
  readonly onCommand?: (command: string, attachments?: readonly PromptAttachment[]) => Promise<void> | void
  readonly onPopupSelect?: (command: string) => void
  readonly onCommandQueryChange?: (query: string | undefined) => void
  readonly onReferenceQueryChange?: (query: string | undefined, quoted: boolean) => void
  readonly onDraftChange: (value: string) => void
  readonly onPickAttachment: () => void
  readonly onIngestFiles: (files: readonly File[]) => void
  readonly openFileCandidates: readonly OpenFileCandidate[]
  readonly openFilePickerOpen: boolean
  readonly openFilePickerLoading: boolean
  readonly preferredOpenFileId?: string
  readonly attachedOpenFileIds: readonly string[]
  readonly attachingOpenFileId?: string
  readonly onToggleOpenFilePicker: () => void
  readonly onSelectOpenFile: (candidateId: string) => void
  readonly onRemoveAttachment: (uri: string) => void
  readonly onSubmit: (mode: RunningInputMode) => void
  readonly onCancel: () => void
  /** Steer every still-queued pending input into the running turn. */
  readonly onSteerQueue: () => void
  /** Pending inbox rows, used to gate the empty-draft accelerated Enter. */
  readonly queue: readonly QueuedInput[]
  /** Plain-Enter behavior while the agent is busy; the accelerated chord uses its opposite. */
  readonly busyEnter?: RunningInputMode
}

export function Composer(props: ComposerProps): ReactElement {
  const { t } = useI18n()
  const composing = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCursorRef = useRef<number | undefined>(undefined)
  const draftHistoryRef = useRef<{ past: string[]; future: string[]; last: string; skip: boolean }>({
    past: [props.draft],
    future: [],
    last: props.draft,
    skip: false,
  })
  const attachmentRailRef = useRef<HTMLUListElement>(null)
  const submitting = useRef(false)
  const dragDepth = useRef(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dropState, setDropState] = useState<'ready' | 'blocked' | undefined>(undefined)
  const [attachmentRailScrollable, setAttachmentRailScrollable] = useState(false)
  const [previewUri, setPreviewUri] = useState<string | undefined>(undefined)
  // Official input-trigger menu state: the highlight rides
  // aria-activedescendant, and Escape dismisses until the query changes.
  const [menuHighlight, setMenuHighlight] = useState<number | undefined>(undefined)
  const [menuHighlightFor, setMenuHighlightFor] = useState<string | undefined>(undefined)
  const [menuDismissed, setMenuDismissed] = useState<string | undefined>(undefined)
  const [referenceCursor, setReferenceCursor] = useState(() => props.draft.length)
  const [referenceHighlight, setReferenceHighlight] = useState<number | undefined>(undefined)
  const [referenceHighlightFor, setReferenceHighlightFor] = useState<string | undefined>(undefined)
  const [referenceDismissed, setReferenceDismissed] = useState<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (textareaRef.current !== null) {
      fitComposerTextarea(textareaRef.current)
      if (pendingCursorRef.current !== undefined) {
        const cursor = Math.max(0, Math.min(pendingCursorRef.current, props.draft.length))
        textareaRef.current.setSelectionRange(cursor, cursor)
        pendingCursorRef.current = undefined
      }
    }
  }, [props.draft])

  useEffect(() => {
    const history = draftHistoryRef.current
    if (history.last === props.draft) return
    history.last = props.draft
    if (history.skip) {
      history.skip = false
      return
    }
    history.past.push(props.draft)
    if (history.past.length > 100) history.past.shift()
    history.future = []
  }, [props.draft])

  useEffect(() => {
    const hasFiles = (event: globalThis.DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDropState(props.disabled || props.attachmentsDisabled === true ? 'blocked' : 'ready')
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
  }, [props.attachmentsDisabled, props.disabled])

  useEffect(() => {
    const element = attachmentRailRef.current
    if (element === null) return
    const update = (): void => setAttachmentRailScrollable(element.scrollWidth > element.clientWidth + 1)
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [props.attachments.length])
  const configuration = props.configuration
  const onConfigurationChange = props.onConfigurationChange
  const onCommand = props.onCommand
  const commandQuery = slashCommandQuery(props.draft)
  const availableCommandPermissionPresets = permissionOptions(
    configuration?.permissionPreset ?? '',
    props.permissionPresets ?? [],
  )
  const commandArgumentOptions = commandInputOptions(
    commandQuery,
    props.commands ?? [],
    availableCommandPermissionPresets,
  )
  const commandPaletteSelection =
    commandQuery === undefined || props.commands === undefined
      ? undefined
      : firstCommandPaletteSelection(commandQuery, props.commands, commandArgumentOptions)
  const menuRows =
    commandQuery === undefined || props.commands === undefined
      ? []
      : commandMenuRows(commandQuery, props.commands, commandArgumentOptions)
  const referenceToken = referenceQueryToken(props.draft, referenceCursor)
  const referenceKey =
    referenceToken === undefined
      ? undefined
      : `${referenceToken.start}:${referenceToken.end}:${referenceToken.quoted ? 'quoted' : 'plain'}:${referenceToken.query}`
  const menuOpen =
    commandQuery !== undefined &&
    props.commands !== undefined &&
    props.commands.length > 0 &&
    menuDismissed !== commandQuery &&
    referenceToken === undefined
  const referenceMenuOpen =
    referenceToken !== undefined && props.references !== undefined && referenceDismissed !== referenceKey
  // Official behavior, adjusted during render (React's sanctioned pattern for
  // prop-driven resets): a changed query restarts the highlight tier, and the
  // effective highlight can never point past the last rendered row.
  if (menuHighlightFor !== commandQuery) {
    setMenuHighlightFor(commandQuery)
    setMenuHighlight(undefined)
  }
  if (referenceHighlightFor !== referenceKey) {
    setReferenceHighlightFor(referenceKey)
    setReferenceHighlight(undefined)
  }
  const highlight = menuHighlight !== undefined && menuHighlight < menuRows.length ? menuHighlight : undefined
  const referenceHighlightValue =
    referenceHighlight !== undefined && referenceHighlight < (props.references?.length ?? 0)
      ? referenceHighlight
      : undefined
  const openFileCandidates = orderOpenFileCandidates(props.openFileCandidates, props.preferredOpenFileId)
  const defaultOpenFileId =
    props.preferredOpenFileId !== undefined &&
    openFileCandidates.some((candidate) => candidate.id === props.preferredOpenFileId)
      ? props.preferredOpenFileId
      : openFileCandidates.find((candidate) => candidate.active)?.id
  const attachedOpenFileIds = new Set(props.attachedOpenFileIds)
  const submit = (mode: RunningInputMode): void => {
    if (
      props.disabled ||
      props.inputDisabled === true ||
      submitting.current ||
      (props.draft.trim() === '' && props.attachments.length === 0)
    )
      return
    submitting.current = true
    setIsSubmitting(true)
    props.onSubmit(mode)
    window.setTimeout(() => {
      submitting.current = false
      setIsSubmitting(false)
    }, 250)
  }
  const ingestFiles = (files: readonly File[] | FileList | undefined): void => {
    if (props.attachmentsDisabled === true) return
    const list = files === undefined ? [] : Array.from(files)
    if (list.length === 0) return
    props.onIngestFiles(list)
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (props.attachmentsDisabled === true) return
    if (event.clipboardData.files.length > 0) {
      event.preventDefault()
      ingestFiles(event.clipboardData.files)
    }
  }
  const onDragEnter = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (props.disabled || props.attachmentsDisabled === true) {
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
    if (props.disabled || props.attachmentsDisabled === true) setDropState('blocked')
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
    if (props.disabled || props.attachmentsDisabled === true) {
      setDropState(undefined)
      return
    }
    setDropState(undefined)
    ingestFiles(event.dataTransfer.files)
  }

  const restoreDraft = (direction: 'undo' | 'redo'): void => {
    const history = draftHistoryRef.current
    if (direction === 'undo') {
      if (history.past.length <= 1) return
      const current = history.past.pop()
      if (current === undefined) return
      history.future.unshift(current)
      const previous = history.past[history.past.length - 1]
      if (previous === undefined) return
      history.skip = true
      history.last = previous
      props.onDraftChange(previous)
      return
    }
    const next = history.future.shift()
    if (next === undefined) return
    history.past.push(next)
    history.skip = true
    history.last = next
    props.onDraftChange(next)
  }

  const deleteEmbeddedReference = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!(event.metaKey || event.ctrlKey) || (event.key !== 'Backspace' && event.key !== 'Delete'))
      return false
    const textarea = textareaRef.current
    if (textarea === null || textarea.selectionStart !== textarea.selectionEnd) return false
    const range = embeddedReferenceRange(props.draft, textarea.selectionStart, event.key === 'Backspace')
    if (range === undefined) return false
    event.preventDefault()
    props.onDraftChange(props.draft.slice(0, range.start) + props.draft.slice(range.end))
    pendingCursorRef.current = range.start
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      restoreDraft(event.shiftKey ? 'redo' : 'undo')
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      restoreDraft('redo')
      return
    }
    if (deleteEmbeddedReference(event)) return
    if (referenceMenuOpen && !composing.current && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const candidates = props.references ?? []
        if (candidates.length > 0) {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setReferenceHighlight((current) => {
            const base = current === undefined ? (step > 0 ? -1 : 0) : current
            return (base + step + candidates.length) % candidates.length
          })
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setReferenceDismissed(referenceKey)
        setReferenceHighlight(undefined)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.repeat) {
        const candidates = props.references ?? []
        const selected =
          referenceHighlightValue === undefined ? candidates[0] : candidates[referenceHighlightValue]
        if (selected !== undefined) {
          event.preventDefault()
          selectReference(selected)
          return
        }
      }
    }
    // Official menu arbitration runs behind the IME composition guard: while
    // the trigger menu is open it intercepts ArrowUp/ArrowDown (highlight),
    // Escape (dismiss until the query changes), and Enter (pick the
    // highlighted row, or run the enter transaction on the full line).
    if (menuOpen && !composing.current && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (menuRows.length > 0) {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setMenuHighlight((current) => {
            const base = current === undefined ? -1 : current
            return (base + step + menuRows.length) % menuRows.length
          })
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuDismissed(commandQuery)
        setMenuHighlight(undefined)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.repeat) {
        const highlighted = menuHighlight === undefined ? undefined : menuRows[menuHighlight]
        if (highlighted !== undefined) {
          event.preventDefault()
          pickMenuRow(highlighted)
          return
        }
        const line = leadingSlashCommandLine(props.draft)
        const command =
          line === undefined ? undefined : props.commands?.find((entry) => entry.name === line.name)
        if (
          line !== undefined &&
          command !== undefined &&
          (command.input !== undefined || line.args === '')
        ) {
          event.preventDefault()
          adjudicateCommandLine(command, line.args)
          return
        }
        // Unknown commands and bare-token commands carrying args answer
        // undefined in the official enter adjudication: the line falls to
        // the default sink (the ordinary Enter submit below).
      }
    }
    if (
      commandPaletteSelection !== undefined &&
      !props.running &&
      event.key === 'Tab' &&
      !composing.current &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      applyCommandSelection(commandPaletteSelection, false)
      return
    }
    if (event.key !== 'Enter') return
    // Shift+Enter is the native newline UNCONDITIONALLY — decided before the
    // IME guard so a composition-closing Shift+Enter still breaks the line.
    if (event.shiftKey) return
    // IME guard: composition Enter picks a candidate, it must not send.
    // keyCode 229 is the legacy IME-composition signal engines emit without
    // isComposing.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    // Held-down Enter must not machine-gun sends.
    if (event.repeat) return
    const accelerated = event.ctrlKey || event.metaKey
    const empty = props.draft.trim() === '' && props.attachments.length === 0
    // Empty-draft accelerated Enter acts on the queue instead of the (empty)
    // draft: the gesture steers every still-pending queued message into the
    // running turn (the dock's per-row steer button applied to the whole
    // queue). Steering needs the same window as the per-row button: a running
    // ordinary session with at least one queued row.
    if (accelerated && empty && props.running && props.queue.some((item) => item.mode === 'queue')) {
      props.onSteerQueue()
      return
    }
    submit(resolveSubmitMode(props.running, accelerated, props.busyEnter ?? 'queue'))
  }
  const pickMenuRow = (row: CommandMenuRow): void => {
    if (row.kind === 'argument') {
      applyCommandSelection({ command: row.command, argument: row.option.value }, true)
      return
    }
    applyCommandSelection({ command: row.command }, true)
  }
  /** Official enter transaction: an args-tolerant command submits the full
   * line (`/goal fix bugs`) through commands/execute; a bare-token command
   * submits only the exact token. */
  const adjudicateCommandLine = (command: DynamicCommand, args: string): void => {
    if (onCommand === undefined) return
    submitCommand(args === '' ? `/${command.name}` : `/${command.name} ${args}`)
  }
  const applyCommandSelection = (selection: CommandPaletteSelection, executeNoInput: boolean): void => {
    const command = selection.command
    if (
      executeNoInput &&
      selection.argument === undefined &&
      commandDispatchKind(command, props.popupSelects) === 'popupSelect' &&
      props.onPopupSelect !== undefined
    ) {
      props.onPopupSelect(command.name)
      return
    }
    if (
      executeNoInput &&
      selection.argument === undefined &&
      command.input === undefined &&
      onCommand !== undefined
    ) {
      submitCommand(`/${command.name}`)
      return
    }
    props.onDraftChange(
      selection.argument === undefined
        ? `/${command.name}${command.input === undefined ? '' : ' '}`
        : `/${command.name} ${selection.argument}`,
    )
  }
  const submitCommand = (command: string): void => {
    if (onCommand === undefined) return
    const result = props.attachments.length === 0 ? onCommand(command) : onCommand(command, props.attachments)
    if (result !== undefined && typeof result.then === 'function')
      void result.then(
        () => props.onDraftChange(''),
        () => undefined,
      )
    else props.onDraftChange('')
  }
  const selectReference = (candidate: ReferenceCandidate): void => {
    if (referenceToken === undefined) return
    const inserted = referenceMention(candidate)
    const next = props.draft.slice(0, referenceToken.start) + inserted + props.draft.slice(referenceToken.end)
    const nextCursor = referenceToken.start + inserted.length
    props.onDraftChange(next)
    setReferenceCursor(nextCursor)
    setReferenceHighlight(undefined)
    setReferenceDismissed(undefined)
    const nextToken = referenceQueryToken(next, nextCursor)
    props.onReferenceQueryChange?.(nextToken?.query, nextToken?.quoted ?? false)
  }
  const previews = props.attachmentPreviews ?? {}
  const previewedAttachment =
    previewUri === undefined ? undefined : props.attachments.find((item) => item.uri === previewUri)
  return (
    <form
      className={`dsh-composer${dragging ? ' dsh-composer--dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onSubmit={(event) => {
        event.preventDefault()
        // The primary button is Stop while running (input stays free); the
        // implicit form submit only exists for the idle Send path.
        if (props.running) props.onCancel()
        else submit('queue')
      }}
    >
      {dropState !== undefined ? (
        <div
          className={`dsh-drop-overlay dsh-drop-overlay--${dropState}`}
          data-state={dropState}
          role="status"
          aria-live="polite"
        >
          <Icon name="paperclip" />
          <span>
            {dropState === 'blocked'
              ? t('composer.dropBlocked')
              : props.imageLimits === undefined
                ? t('composer.drop')
                : t('composer.dropWithLimits', {
                    count: props.imageLimits.maxImagesPerMessage,
                    size: formatByteSize(props.imageLimits.maxImageBytes),
                  })}
          </span>
        </div>
      ) : null}
      {props.attachments.length > 0 ? (
        <div className="dsh-composer__attachment-rail">
          {attachmentRailScrollable ? (
            <button
              className="dsh-composer__attachment-page dsh-composer__attachment-page--previous"
              type="button"
              aria-label={t('composer.attachmentsPrevious')}
              onClick={() => pageAttachmentRail(attachmentRailRef.current, -1)}
            >
              <Icon name="chevron-left" />
            </button>
          ) : null}
          <ul
            ref={attachmentRailRef}
            className="dsh-composer__attachments"
            aria-label={t('composer.attachments')}
            onWheel={(event) => {
              const element = event.currentTarget
              if (event.deltaX === 0 && event.deltaY !== 0 && element.scrollWidth > element.clientWidth) {
                event.preventDefault()
                element.scrollLeft += event.deltaY
              }
            }}
          >
            {props.attachments.map((attachment) => {
              const isImage = attachment.mimeType?.startsWith('image/') === true
              const preview = previews[attachment.uri]
              return (
                <li className="dsh-composer__attachment" key={attachment.uri}>
                  {isImage ? (
                    <button
                      className="dsh-composer__attachment-thumb"
                      type="button"
                      aria-label={t('composer.preview', { name: attachment.name })}
                      title={t('composer.preview', { name: attachment.name })}
                      onClick={() => setPreviewUri(attachment.uri)}
                    >
                      {preview === undefined ? (
                        <Icon name="image" />
                      ) : (
                        <img src={preview} alt="" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    <span className="dsh-composer__attachment-preview" aria-hidden="true">
                      <Icon name="file" />
                    </span>
                  )}
                  <span className="dsh-composer__attachment-name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <button
                    className="dsh-icon-button dsh-composer__attachment-remove"
                    type="button"
                    aria-label={t('composer.remove', { name: attachment.name })}
                    onClick={() => {
                      if (previewUri === attachment.uri) setPreviewUri(undefined)
                      props.onRemoveAttachment(attachment.uri)
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              )
            })}
          </ul>
          {attachmentRailScrollable ? (
            <button
              className="dsh-composer__attachment-page dsh-composer__attachment-page--next"
              type="button"
              aria-label={t('composer.attachmentsNext')}
              onClick={() => pageAttachmentRail(attachmentRailRef.current, 1)}
            >
              <Icon name="chevron-right" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="dsh-composer__input-shell">
        <textarea
          ref={textareaRef}
          className="dsh-composer__textarea"
          aria-label={t('composer.prompt')}
          value={props.draft}
          disabled={props.disabled || props.inputDisabled === true}
          {...(menuOpen
            ? {
                'aria-expanded': true,
                'aria-controls': COMMAND_MENU_ID,
                'aria-autocomplete': 'list',
              }
            : referenceMenuOpen
              ? {
                  'aria-expanded': true,
                  'aria-controls': REFERENCE_MENU_ID,
                  'aria-autocomplete': 'list',
                }
              : {})}
          {...(referenceMenuOpen && referenceHighlightValue !== undefined
            ? { 'aria-activedescendant': referenceMenuOptionId(referenceHighlightValue) }
            : menuOpen && highlight !== undefined
              ? { 'aria-activedescendant': commandMenuOptionId(highlight) }
              : {})}
          onChange={(event) => {
            const value = event.target.value
            fitComposerTextarea(event.currentTarget)
            const cursor =
              event.currentTarget.selectionStart === 0 && props.draft.length === 0
                ? value.length
                : event.currentTarget.selectionStart
            setReferenceCursor(cursor)
            props.onDraftChange(value)
            props.onCommandQueryChange?.(slashCommandQuery(value))
            const token = referenceQueryToken(value, cursor)
            props.onReferenceQueryChange?.(token?.query, token?.quoted ?? false)
          }}
          onSelect={(event) => {
            const cursor = event.currentTarget.selectionStart
            setReferenceCursor(cursor)
            const token = referenceQueryToken(event.currentTarget.value, cursor)
            props.onReferenceQueryChange?.(token?.query, token?.quoted ?? false)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            // Safari delivers the closing keydown AFTER compositionend, so
            // clearing the guard is deferred one tick (official 10ms window).
            window.setTimeout(() => {
              composing.current = false
            }, 10)
          }}
          placeholder={t('composer.placeholder')}
          rows={1}
        />
        {referenceToken === undefined || props.references === undefined || !referenceMenuOpen ? null : (
          <ReferencePalette
            candidates={props.references}
            loading={props.referenceLoading === true}
            {...(referenceHighlightValue === undefined ? {} : { highlight: referenceHighlightValue })}
            onSelect={selectReference}
          />
        )}
        {referenceToken !== undefined ||
        commandQuery === undefined ||
        props.commands === undefined ||
        props.commands.length === 0 ? null : (
          <CommandPalette
            commands={props.commands}
            query={commandQuery}
            argumentOptions={commandArgumentOptions}
            {...(props.popupSelects === undefined ? {} : { popupSelects: props.popupSelects })}
            {...(menuDismissed === undefined ? {} : { dismissedFor: menuDismissed })}
            {...(highlight === undefined ? {} : { highlight })}
            onExecute={(name, argument) => {
              const command = props.commands?.find((entry) => entry.name === name)
              if (command === undefined) return
              applyCommandSelection({ command, ...(argument === undefined ? {} : { argument }) }, true)
            }}
            onPopupSelect={(name) => props.onPopupSelect?.(name)}
          />
        )}
      </div>
      <div className="dsh-composer__toolbar">
        <div className="dsh-composer__toolbar-start">
          <button
            className="dsh-icon-button dsh-composer__attach"
            type="button"
            aria-label={t('composer.attach')}
            title={t('composer.attach')}
            disabled={props.disabled || props.running || props.attachmentsDisabled === true}
            onClick={props.onPickAttachment}
          >
            <Icon name="paperclip" />
          </button>
          <div className="dsh-composer__open-files">
            <button
              className="dsh-icon-button dsh-composer__current-file"
              type="button"
              aria-label={t('composer.chooseOpenFile')}
              title={t('composer.chooseOpenFile')}
              disabled={props.disabled || props.running || props.attachmentsDisabled === true}
              aria-expanded={props.openFilePickerOpen}
              onClick={props.onToggleOpenFilePicker}
            >
              <Icon name="file" />
            </button>
            {props.openFilePickerOpen ? (
              <div className="dsh-open-file-picker" role="dialog" aria-label={t('composer.openFiles')}>
                <div className="dsh-open-file-picker__header">
                  <span>{t('composer.openFiles')}</span>
                  <button
                    className="dsh-icon-button dsh-open-file-picker__close"
                    type="button"
                    aria-label={t('composer.closeOpenFiles')}
                    onClick={props.onToggleOpenFilePicker}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                {props.openFilePickerLoading ? (
                  <p className="dsh-open-file-picker__empty">{t('composer.loading')}</p>
                ) : openFileCandidates.length === 0 ? (
                  <p className="dsh-open-file-picker__empty">{t('composer.noOpenFiles')}</p>
                ) : (
                  <ul
                    className="dsh-open-file-picker__list"
                    role="listbox"
                    aria-label={t('composer.openFiles')}
                  >
                    {openFileCandidates.map((candidate) => {
                      const attached = attachedOpenFileIds.has(candidate.id)
                      const attaching = props.attachingOpenFileId === candidate.id
                      const remembered = defaultOpenFileId === candidate.id
                      return (
                        <li key={candidate.id}>
                          <button
                            className={`dsh-open-file-picker__option${
                              remembered ? ' dsh-open-file-picker__option--remembered' : ''
                            }`}
                            type="button"
                            role="option"
                            aria-selected={remembered}
                            disabled={
                              !candidate.supported || attached || props.attachingOpenFileId !== undefined
                            }
                            onClick={() => props.onSelectOpenFile(candidate.id)}
                          >
                            <span className="dsh-open-file-picker__icon" aria-hidden="true">
                              <Icon
                                name={candidate.mimeType?.startsWith('image/') === true ? 'image' : 'file'}
                              />
                            </span>
                            <span className="dsh-open-file-picker__name" title={candidate.name}>
                              {candidate.name}
                            </span>
                            <span className="dsh-open-file-picker__status">
                              {attaching
                                ? t('composer.adding')
                                : attached
                                  ? t('composer.added')
                                  : !candidate.supported
                                    ? t('composer.unsupported')
                                    : candidate.active
                                      ? t('composer.current')
                                      : ''}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
          <span
            className="dsh-composer__hint"
            title={props.running ? t('composer.runningHint') : t('composer.idleHint')}
          >
            {props.running ? t('composer.runningHintShort') : t('composer.idleHintShort')}
          </span>
        </div>
        {configuration === undefined || onConfigurationChange === undefined ? (
          <span className="dsh-composer__toolbar-spacer" aria-hidden="true" />
        ) : (
          <SessionControls
            configuration={configuration}
            models={props.models ?? []}
            presets={props.presets ?? []}
            permissionPresets={props.permissionPresets ?? []}
            {...(props.commands === undefined ? {} : { commands: props.commands })}
            {...(props.estimatedContextTokens === undefined
              ? {}
              : { estimatedContextTokens: props.estimatedContextTokens })}
            {...(props.contextWindowTokens === undefined
              ? {}
              : { contextWindowTokens: props.contextWindowTokens })}
            {...(props.contextBreakdown === undefined ? {} : { contextBreakdown: props.contextBreakdown })}
            disabled={props.configurationDisabled ?? (props.disabled || props.running)}
            presetMutable={props.presetMutable === true}
            {...(props.modelPickerOpenRequest === undefined
              ? {}
              : { modelPickerOpenRequest: props.modelPickerOpenRequest })}
            onChange={onConfigurationChange}
            onCommand={(command) => {
              void Promise.resolve(onCommand?.(command)).catch(() => undefined)
            }}
          />
        )}
        <button
          className={`dsh-button dsh-composer__submit ${props.running ? 'dsh-button--danger' : 'dsh-button--primary'}`}
          type="submit"
          aria-label={props.running ? t('composer.stopResponse') : t('composer.sendMessage')}
          title={props.running ? t('composer.stopResponse') : t('composer.sendMessage')}
          disabled={
            props.disabled ||
            (!props.running && props.inputDisabled === true) ||
            isSubmitting ||
            (!props.running && props.draft.trim() === '' && props.attachments.length === 0)
          }
        >
          <Icon name={props.running ? 'stop' : 'send'} />
          <span className="dsh-composer__send-label">
            {props.running ? t('composer.stop') : t('composer.send')}
          </span>
        </button>
      </div>
      {previewedAttachment === undefined ? null : (
        <AttachmentLightbox
          name={previewedAttachment.name}
          src={previews[previewedAttachment.uri]}
          onClose={() => setPreviewUri(undefined)}
        />
      )}
    </form>
  )
}

function formatByteSize(value: number): string {
  if (value >= 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MiB`
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`
  return `${value} B`
}

function fitComposerTextarea(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  const contentHeight = Math.max(COMPOSER_MIN_HEIGHT, element.scrollHeight)
  const nextHeight = Math.min(contentHeight, COMPOSER_MAX_HEIGHT)
  element.style.height = `${nextHeight}px`
  element.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
}

function pageAttachmentRail(element: HTMLUListElement | null, direction: -1 | 1): void {
  if (element === null) return
  const distance = Math.max(160, Math.floor(element.clientWidth * 0.8))
  element.scrollBy({ left: direction * distance, behavior: 'smooth' })
}

interface EmbeddedReferenceRange {
  readonly start: number
  readonly end: number
}

function embeddedReferenceRange(
  value: string,
  cursor: number,
  backwards: boolean,
): EmbeddedReferenceRange | undefined {
  const references = /@\[[^\]\r\n]{1,512}\]\(dsh-session:[A-Za-z0-9_-]{1,512}\)/gu
  for (const match of value.matchAll(references)) {
    const start = match.index
    const end = start + match[0].length
    if ((backwards && cursor === end) || (!backwards && cursor === start)) return { start, end }
  }
  return undefined
}

function orderOpenFileCandidates(
  candidates: readonly OpenFileCandidate[],
  preferredId: string | undefined,
): readonly OpenFileCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftRank = left.id === preferredId ? 0 : left.active ? 1 : 2
    const rightRank = right.id === preferredId ? 0 : right.active ? 1 : 2
    return leftRank - rightRank
  })
}

interface ReferenceQueryToken {
  readonly start: number
  readonly end: number
  readonly query: string
  readonly quoted: boolean
}

/** Find the unfinished `@path`/`@"path with spaces` token at the caret. */
function referenceQueryToken(value: string, cursor: number): ReferenceQueryToken | undefined {
  const boundedCursor = Math.max(0, Math.min(cursor, value.length))
  const at = value.slice(0, boundedCursor).lastIndexOf('@')
  if (at < 0) return undefined
  const before = at === 0 ? '' : value.charAt(at - 1)
  if (before !== '' && !/\s/u.test(before)) return undefined
  const tail = value.slice(at + 1, boundedCursor)
  if (tail.startsWith('[')) return undefined
  if (tail.startsWith('"')) {
    const query = tail.slice(1)
    if (query.includes('"') || /\r|\n/u.test(query)) return undefined
    return { start: at, end: boundedCursor, query, quoted: true }
  }
  if (tail.includes('"') || /\s/u.test(tail)) return undefined
  return { start: at, end: boundedCursor, query: tail, quoted: false }
}

function referenceMention(candidate: ReferenceCandidate): string {
  if (candidate.kind === 'session') return candidate.mention
  const path =
    candidate.kind === 'directory' && !candidate.path.endsWith('/') ? `${candidate.path}/` : candidate.path
  return `@${/[\s"]/u.test(path) ? `"${path}"` : path}`
}

function slashCommandQuery(value: string): string | undefined {
  const firstLine = value.split('\n', 1)[0] ?? ''
  return /^\/(?:[a-z][a-z0-9_-]*(?:[ \t]+[^\n]*)?)?$/u.test(firstLine) ? firstLine : undefined
}

/** Official enter adjudication parses the full trimmed draft — exactly one
 * line shaped `/<name>` or `/<name> <args>`; multi-line drafts are ordinary
 * prompts and never claim. */
function leadingSlashCommandLine(
  value: string,
): { readonly name: string; readonly args: string } | undefined {
  if (value.includes('\n')) return undefined
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+(.*))?$/u.exec(value.trim())
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1], args: match[2] === undefined ? '' : match[2].trim() }
}

function commandInputOptions(
  query: string | undefined,
  commands: readonly DynamicCommand[],
  permissionPresets: readonly string[],
): readonly CommandArgumentOption[] {
  if (query === undefined) return []
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+.*)?$/u.exec(query)
  const commandName = match?.[1]
  if (commandName === undefined) return []
  const command = commands.find((entry) => entry.name === commandName)
  if (command === undefined || command.input === undefined) return []

  // Permission ids come from DSH's session detail/projection. They are the
  // only argument values this client may complete because they are dynamic
  // host data rather than a locally maintained command allowlist.
  if (/^<preset>$/iu.test(command.input.hint.trim())) {
    return uniqueArgumentOptions(permissionPresets, formatPermissionLabel)
  }

  // The rc.6 built-in plan descriptor advertises the optional literal `off`.
  // Only complete a single literal hint; arbitrary free-form command input
  // must remain under the command registry's own parser.
  const literal = /^\[([a-z][a-z0-9_-]*)\]$/u.exec(command.input.hint.trim())
  if (literal?.[1] === 'off') return [{ value: 'off', label: 'off' }]
  return []
}

function uniqueArgumentOptions(
  values: readonly string[],
  label = formatArgumentLabel,
): readonly CommandArgumentOption[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].map((value) => ({
    value,
    label: label(value),
  }))
}

function formatArgumentLabel(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * Official submission policy (ComposerSubmissionPolicy.resolve): an idle
 * agent always receives `queue`; while running, plain Enter resolves to the
 * busy-Enter preference and the Cmd/Ctrl-accelerated chord to its opposite.
 * Direct `steer` is intentionally best-effort — a closed delivery window
 * turns the submission into the next waking Queue item.
 */
function resolveSubmitMode(
  running: boolean,
  accelerated: boolean,
  busyEnter: RunningInputMode,
): RunningInputMode {
  if (!running) return 'queue'
  if (accelerated) return busyEnter === 'queue' ? 'steer' : 'queue'
  return busyEnter
}
