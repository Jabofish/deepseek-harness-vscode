import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type {
  AgentConfiguration,
  AgentPresetDescriptor,
  DynamicCommand,
  ModelDescriptor,
  PromptAttachment,
} from '@dsh-vscode/domain'
import type { OpenFileCandidate } from '../../app/store.js'
import { Icon } from '../../ui/Icon.js'
import {
  CommandPalette,
  firstCommandPaletteSelection,
  type CommandArgumentOption,
  type CommandPaletteSelection,
} from '../commands/CommandPalette.js'
import { formatPermissionLabel, permissionOptions, SessionControls } from './SessionControls.js'

export interface ComposerProps {
  readonly disabled: boolean
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
  readonly cacheHitRate?: number
  readonly configurationDisabled?: boolean
  readonly presetMutable?: boolean
  readonly onConfigurationChange?: (configuration: AgentConfiguration) => void
  readonly onCommand?: (command: string) => void
  readonly onCommandQueryChange?: (query: string | undefined) => void
  readonly onDraftChange: (value: string) => void
  readonly onPickAttachment: () => void
  readonly openFileCandidates: readonly OpenFileCandidate[]
  readonly openFilePickerOpen: boolean
  readonly openFilePickerLoading: boolean
  readonly preferredOpenFileId?: string
  readonly attachedOpenFileIds: readonly string[]
  readonly attachingOpenFileId?: string
  readonly onToggleOpenFilePicker: () => void
  readonly onSelectOpenFile: (candidateId: string) => void
  readonly onRemoveAttachment: (uri: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

export function Composer(props: ComposerProps): ReactElement {
  const composing = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
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
  const openFileCandidates = orderOpenFileCandidates(props.openFileCandidates, props.preferredOpenFileId)
  const defaultOpenFileId =
    props.preferredOpenFileId !== undefined &&
    openFileCandidates.some((candidate) => candidate.id === props.preferredOpenFileId)
      ? props.preferredOpenFileId
      : openFileCandidates.find((candidate) => candidate.active)?.id
  const attachedOpenFileIds = new Set(props.attachedOpenFileIds)
  const submit = (): void => {
    if (props.disabled || submitting.current || (props.draft.trim() === '' && props.attachments.length === 0))
      return
    submitting.current = true
    setIsSubmitting(true)
    props.onSubmit()
    window.setTimeout(() => {
      submitting.current = false
      setIsSubmitting(false)
    }, 250)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      commandPaletteSelection !== undefined &&
      !props.running &&
      (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) &&
      !composing.current &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      applyCommandSelection(commandPaletteSelection, event.key === 'Enter')
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (props.running) props.onCancel()
    else submit()
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
    window.setTimeout(() => {
      const textarea = textareaRef.current
      if (textarea === null) return
      textarea.focus()
      const end = textarea.value.length
      textarea.setSelectionRange(end, end)
    }, 0)
  }
  return (
    <form
      className="dsh-composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (props.running) props.onCancel()
        else submit()
      }}
    >
      {props.attachments.length > 0 ? (
        <ul className="dsh-composer__attachments" aria-label="Attached files">
          {props.attachments.map((attachment) => (
            <li className="dsh-composer__attachment" key={attachment.uri}>
              <span className="dsh-composer__attachment-preview" aria-hidden="true">
                <Icon name={attachment.mimeType?.startsWith('image/') === true ? 'image' : 'file'} />
              </span>
              <span className="dsh-composer__attachment-name" title={attachment.name}>
                {attachment.name}
              </span>
              <button
                className="dsh-icon-button dsh-composer__attachment-remove"
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => props.onRemoveAttachment(attachment.uri)}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dsh-composer__input-shell">
        <textarea
          ref={textareaRef}
          className="dsh-composer__textarea"
          aria-label="Prompt"
          value={props.draft}
          disabled={props.disabled || props.running}
          onChange={(event) => {
            const value = event.target.value
            props.onDraftChange(value)
            props.onCommandQueryChange?.(slashCommandQuery(value))
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          placeholder="Message…"
          rows={3}
        />
        {commandQuery === undefined || props.commands === undefined || props.commands.length === 0 ? null : (
          <CommandPalette
            commands={props.commands}
            query={commandQuery}
            argumentOptions={commandArgumentOptions}
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
            aria-label="Attach file"
            title="Attach file"
            disabled={props.disabled || props.running}
            onClick={props.onPickAttachment}
          >
            <Icon name="paperclip" />
          </button>
          <div className="dsh-composer__open-files">
            <button
              className="dsh-icon-button dsh-composer__current-file"
              type="button"
              aria-label="Choose an open file"
              title="Choose an open file"
              disabled={props.disabled || props.running}
              aria-expanded={props.openFilePickerOpen}
              onClick={props.onToggleOpenFilePicker}
            >
              <Icon name="file" />
            </button>
            {props.openFilePickerOpen ? (
              <div className="dsh-open-file-picker" role="dialog" aria-label="Open files">
                <div className="dsh-open-file-picker__header">
                  <span>Open files</span>
                  <button
                    className="dsh-icon-button dsh-open-file-picker__close"
                    type="button"
                    aria-label="Close open files"
                    onClick={props.onToggleOpenFilePicker}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                {props.openFilePickerLoading ? (
                  <p className="dsh-open-file-picker__empty">Loading…</p>
                ) : openFileCandidates.length === 0 ? (
                  <p className="dsh-open-file-picker__empty">No open files.</p>
                ) : (
                  <ul className="dsh-open-file-picker__list" role="listbox" aria-label="Open files">
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
                                ? 'Adding…'
                                : attached
                                  ? 'Added'
                                  : !candidate.supported
                                    ? 'Unsupported'
                                    : candidate.active
                                      ? 'Current'
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
          <span className="dsh-composer__hint" title="Shift+Enter for a new line">
            Enter to {props.running ? 'stop' : 'send'}
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
            estimatedContextTokens={props.estimatedContextTokens ?? 0}
            {...(props.contextWindowTokens === undefined
              ? {}
              : { contextWindowTokens: props.contextWindowTokens })}
            cacheHitRate={props.cacheHitRate ?? 0}
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
          aria-label={props.running ? 'Stop response' : 'Send message'}
          title={props.running ? 'Stop response' : 'Send message'}
          disabled={
            props.disabled ||
            isSubmitting ||
            (!props.running && props.draft.trim() === '' && props.attachments.length === 0)
          }
        >
          <Icon name={props.running ? 'stop' : 'send'} />
          <span className="dsh-composer__send-label">{props.running ? 'Stop' : 'Send'}</span>
        </button>
      </div>
    </form>
  )
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
