import {
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
  DynamicCommand,
  ModelDescriptor,
  PromptAttachment,
  QueuedInput,
  RunningInputMode,
} from '@dsh-vscode/domain'
import type { OpenFileCandidate } from '../../app/store.js'
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
import { formatPermissionLabel, permissionOptions, SessionControls } from './SessionControls.js'

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
  readonly configuration?: AgentConfiguration | undefined
  readonly models?: readonly ModelDescriptor[]
  readonly presets?: readonly AgentPresetDescriptor[]
  readonly permissionPresets?: readonly string[]
  readonly commands?: readonly DynamicCommand[]
  readonly modelPickerOpenRequest?: number
  readonly estimatedContextTokens?: number
  readonly contextWindowTokens?: number
  readonly configurationDisabled?: boolean
  readonly presetMutable?: boolean
  readonly attachmentPreviews?: Readonly<Record<string, string>>
  readonly onConfigurationChange?: (configuration: AgentConfiguration) => void
  readonly onCommand?: (command: string) => void
  readonly onCommandQueryChange?: (query: string | undefined) => void
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
  const submitting = useRef(false)
  const dragDepth = useRef(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [previewUri, setPreviewUri] = useState<string | undefined>(undefined)
  // Official input-trigger menu state: the highlight rides
  // aria-activedescendant, and Escape dismisses until the query changes.
  const [menuHighlight, setMenuHighlight] = useState<number | undefined>(undefined)
  const [menuHighlightFor, setMenuHighlightFor] = useState<string | undefined>(undefined)
  const [menuDismissed, setMenuDismissed] = useState<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (textareaRef.current !== null) fitComposerTextarea(textareaRef.current)
  }, [props.draft])
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
  const menuOpen =
    commandQuery !== undefined &&
    props.commands !== undefined &&
    props.commands.length > 0 &&
    menuDismissed !== commandQuery
  // Official behavior, adjusted during render (React's sanctioned pattern for
  // prop-driven resets): a changed query restarts the highlight tier, and the
  // effective highlight can never point past the last rendered row.
  if (menuHighlightFor !== commandQuery) {
    setMenuHighlightFor(commandQuery)
    setMenuHighlight(undefined)
  }
  const highlight = menuHighlight !== undefined && menuHighlight < menuRows.length ? menuHighlight : undefined
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
    if (props.attachmentsDisabled === true) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (event: DragEvent<HTMLFormElement>): void => {
    if (props.attachmentsDisabled === true) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
  }
  const onDragLeave = (): void => {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    if (props.attachmentsDisabled === true) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    ingestFiles(event.dataTransfer.files)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
    onCommand(args === '' ? `/${command.name}` : `/${command.name} ${args}`)
    props.onDraftChange('')
  }
  const applyCommandSelection = (selection: CommandPaletteSelection, executeNoInput: boolean): void => {
    const command = selection.command
    if (
      executeNoInput &&
      selection.argument === undefined &&
      command.input === undefined &&
      onCommand !== undefined
    ) {
      onCommand(`/${command.name}`)
      props.onDraftChange('')
      return
    }
    props.onDraftChange(
      selection.argument === undefined
        ? `/${command.name}${command.input === undefined ? '' : ' '}`
        : `/${command.name} ${selection.argument}`,
    )
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
      {dragging ? (
        <div className="dsh-composer__dropzone" aria-hidden="true">
          <Icon name="paperclip" />
          <span>{t('composer.drop')}</span>
        </div>
      ) : null}
      {props.attachments.length > 0 ? (
        <ul className="dsh-composer__attachments" aria-label={t('composer.attachments')}>
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
            : {})}
          {...(menuOpen && menuHighlight !== undefined
            ? { 'aria-activedescendant': commandMenuOptionId(menuHighlight) }
            : {})}
          onChange={(event) => {
            const value = event.target.value
            fitComposerTextarea(event.currentTarget)
            props.onDraftChange(value)
            props.onCommandQueryChange?.(slashCommandQuery(value))
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
        {commandQuery === undefined || props.commands === undefined || props.commands.length === 0 ? null : (
          <CommandPalette
            commands={props.commands}
            query={commandQuery}
            argumentOptions={commandArgumentOptions}
            {...(menuDismissed === undefined ? {} : { dismissedFor: menuDismissed })}
            {...(highlight === undefined ? {} : { highlight })}
            onExecute={(name, argument) => {
              const command = props.commands?.find((entry) => entry.name === name)
              if (command === undefined) return
              applyCommandSelection({ command, ...(argument === undefined ? {} : { argument }) }, true)
            }}
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
            {...(props.estimatedContextTokens === undefined
              ? {}
              : { estimatedContextTokens: props.estimatedContextTokens })}
            {...(props.contextWindowTokens === undefined
              ? {}
              : { contextWindowTokens: props.contextWindowTokens })}
            disabled={props.configurationDisabled ?? (props.disabled || props.running)}
            presetMutable={props.presetMutable === true}
            {...(props.modelPickerOpenRequest === undefined
              ? {}
              : { modelPickerOpenRequest: props.modelPickerOpenRequest })}
            onChange={onConfigurationChange}
            onCommand={onCommand ?? (() => undefined)}
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

function fitComposerTextarea(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  const contentHeight = Math.max(COMPOSER_MIN_HEIGHT, element.scrollHeight)
  const nextHeight = Math.min(contentHeight, COMPOSER_MAX_HEIGHT)
  element.style.height = `${nextHeight}px`
  element.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
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
