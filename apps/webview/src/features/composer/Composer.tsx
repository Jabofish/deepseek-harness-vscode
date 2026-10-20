import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type {
  AgentConfiguration,
  AgentPresetDescriptor,
  ContextBreakdown,
  DynamicCommand,
  EditorContextItem,
  EditorContextKind,
  EditorContextPreview,
  ImageAttachmentLimits,
  ModelCatalogFailure,
  ModelDescriptor,
  ModelSelection,
  PromptMode,
  PromptAttachment,
  QueuedInput,
  RunningInputMode,
} from '@dsh-vscode/domain'
import type { OpenFileCandidate, ReferenceCandidate } from '../../app/store.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { UnifiedComposer } from '../../components/common/UnifiedComposer.js'
import { AttachmentLightbox } from '../attachments/AttachmentLightbox.js'
import { COMMAND_MENU_ID, CommandPalette, commandMenuOptionId } from '../commands/CommandPalette.js'
import type { PopupSelectRegistry } from '../commands/popupSelectRegistry.js'
import { useAttachmentLightbox } from './useAttachmentLightbox.js'
import { useAttachmentRail } from './useAttachmentRail.js'
import { useComposerDragDrop } from './useComposerDragDrop.js'
import { useComposerMenuState } from './useComposerMenuState.js'
import { useComposerSubmit } from './useComposerSubmit.js'
import { useDraftHistory } from './useDraftHistory.js'
import { ComposerAttachmentsRail } from './ComposerAttachmentsRail.js'
import { SessionControls, type SessionControlsProps } from './SessionControls.js'
import {
  embeddedReferenceRange,
  fitComposerTextarea,
  formatByteSize,
  leadingSlashCommandLine,
  orderOpenFileCandidates,
  referenceQueryToken,
  resolveSubmitMode,
  slashCommandQuery,
} from './composer-input.js'
import { REFERENCE_MENU_ID, ReferencePalette, referenceMenuOptionId } from './ReferencePalette.js'
import { EditorContextRail } from './EditorContextRail.js'
import { ComposerQuickTools } from './ComposerQuickTools.js'
import { useComposerHeightMotion } from './useComposerHeightMotion.js'
import { ComposerCommandActions } from './ComposerCommandActions.js'
import { ComposerExtrasMenu } from './ComposerExtrasMenu.js'
import { ComposerAttachmentActions } from './ComposerAttachmentActions.js'
import { useConversationLayout } from '../../app/ConversationLayoutProvider.js'

const EMPTY_ATTACHMENT_PREVIEWS: Readonly<Record<string, string>> = {}
const EMPTY_MODELS: readonly ModelDescriptor[] = []
const EMPTY_MODEL_FAILURES: readonly ModelCatalogFailure[] = []
const EMPTY_PRESETS: readonly AgentPresetDescriptor[] = []
const EMPTY_EDITOR_CONTEXT: readonly EditorContextItem[] = []
const EMPTY_EDITOR_CONTEXT_KINDS: readonly EditorContextKind[] = []

export interface ComposerProps {
  readonly disabled: boolean
  /** Disable human input while leaving an active turn's Stop action enabled. */
  readonly inputDisabled?: boolean
  /** Disable inline attachments when the selected subagent contract cannot accept them. */
  readonly attachmentsDisabled?: boolean
  readonly running: boolean
  readonly draft: string
  /** Conversation identity that owns the draft; undo history resets with it. */
  readonly draftKey?: string | undefined
  readonly attachments: readonly PromptAttachment[]
  readonly editorContext?: readonly EditorContextItem[]
  readonly editorContextAvailableKinds?: readonly EditorContextKind[]
  readonly editorContextLoading?: boolean
  /** Optional DSH `imageLimits` projection; absent on older/partial hosts. */
  readonly imageLimits?: ImageAttachmentLimits
  readonly configuration?: AgentConfiguration | undefined
  readonly models?: readonly ModelDescriptor[]
  /** Providers the session directory could not enumerate, with the host's reason. */
  readonly modelFailures?: readonly ModelCatalogFailure[]
  /** True while the session model directory is being read. */
  readonly modelLoading?: boolean
  /** The host's reason the session model directory could not be read. */
  readonly modelError?: string
  /** Re-read the session model directory; the picker's own retry surface. */
  readonly onModelRetry?: () => void
  /**
   * The route the host says the session's next request will take. The session's
   * configuration names a model only once someone chose one, so the model seat
   * states this route while the configuration names none.
   */
  readonly modelCurrent?: ModelSelection
  /**
   * Whether the host currently advertises the session's selected model.
   * DSH rc.2 accepts prompts for unavailable models and returns the actionable
   * runtime/provider error, so this is a status hint rather than a send gate.
   */
  readonly modelRoutable?: boolean
  readonly presets?: readonly AgentPresetDescriptor[]
  readonly presetSelectionEnabled?: boolean
  readonly permissionPresets?: readonly string[]
  readonly configurationDraft?: boolean
  readonly defaultPermissionPreset?: string
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
  readonly promptMode?: PromptMode
  readonly configurationDisabled?: boolean
  readonly presetMutable?: boolean
  readonly attachmentPreviews?: Readonly<Record<string, string>>
  /** Handles whose preview request settled without an image (expired draft or
   * Host refusal); the lightbox must say so instead of loading forever. */
  readonly attachmentPreviewFailures?: readonly string[]
  readonly onConfigurationChange?: (configuration: AgentConfiguration) => void | Promise<void>
  readonly onPromptModeChange?: (mode: PromptMode) => void
  readonly onCommand?: (
    command: string,
    attachments?: readonly PromptAttachment[],
    signal?: AbortSignal,
  ) => Promise<void> | void
  readonly onPopupSelect?: (command: string) => void
  readonly onOpenSkillDocument?: (skillId: string) => void
  readonly onCommandQueryChange?: (query: string | undefined) => void
  readonly onReferenceQueryChange?: (query: string | undefined, quoted: boolean) => void
  readonly onDraftChange: (value: string | ((current: string) => string)) => void
  readonly onPickAttachment: () => void
  readonly onIngestFiles: (files: readonly File[]) => void
  readonly openFileCandidates: readonly OpenFileCandidate[]
  readonly openFilePickerOpen: boolean
  readonly openFilePickerLoading: boolean
  readonly preferredOpenFileId?: string
  readonly attachedOpenFileIds: readonly string[]
  readonly attachingOpenFileId?: string
  readonly onToggleOpenFilePicker: () => void
  /** Reports the secondary action menu's open state so the host can refresh the
   * open-file candidates and close the nested picker with that menu. */
  readonly onExtrasOpenChange?: (open: boolean) => void
  readonly onSelectOpenFile: (candidateId: string) => void
  readonly onRemoveAttachment: (uri: string) => void
  readonly onCaptureEditorContext?: (kind: EditorContextKind) => Promise<void> | void
  readonly onRemoveEditorContext?: (contextRef: string) => Promise<void> | void
  readonly onPreviewEditorContext?: (contextRef: string) => Promise<EditorContextPreview | undefined>
  readonly onSubmit: (mode: RunningInputMode, signal?: AbortSignal) => void | Promise<void>
  readonly onCancel: () => void
  /** Steer every still-queued pending input into the running turn. */
  readonly onSteerQueue: () => void | Promise<void>
  /** Pending inbox rows, used to gate the empty-draft accelerated Enter. */
  readonly queue: readonly QueuedInput[]
  /** Plain-Enter behavior while the agent is busy; the accelerated chord uses its opposite. */
  readonly busyEnter?: RunningInputMode
}

export const Composer = memo(function Composer(props: ComposerProps): ReactElement {
  const { t } = useI18n()
  const focused = useConversationLayout()?.layout === 'focused'
  const composerRef = useRef<HTMLFormElement>(null)
  useComposerHeightMotion(composerRef)
  const composing = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const pendingCursorRef = useRef<number | undefined>(undefined)
  const { restoreDraft } = useDraftHistory(props.draft, props.onDraftChange, props.draftKey)
  const { railRef: attachmentRailRef, scrollable: attachmentRailScrollable } = useAttachmentRail(
    props.attachments.length,
  )
  const inputBlocked = props.inputDisabled === true
  const { isSubmitting, isDirectSubmitting, cancelSubmission, submit, steerQueuedInputs } = useComposerSubmit(
    {
      disabled: props.disabled,
      inputBlocked,
      running: props.running,
      draft: props.draft,
      attachments: props.attachments,
      onSubmit: props.onSubmit,
      onSteerQueue: props.onSteerQueue,
    },
  )
  const { previewUri, previewedAttachment, openPreview, closePreview } = useAttachmentLightbox(
    props.attachments,
  )
  const [extrasOpen, setExtrasOpen] = useState(false)
  const changeExtrasOpen = (open: boolean): void => {
    setExtrasOpen(open)
    props.onExtrasOpenChange?.(open)
  }
  useLayoutEffect(() => {
    if (textareaRef.current !== null) {
      fitComposerTextarea(textareaRef.current, focused ? { minimum: 42, maximum: 240 } : undefined)
      if (pendingCursorRef.current !== undefined) {
        const cursor = Math.max(0, Math.min(pendingCursorRef.current, props.draft.length))
        textareaRef.current.setSelectionRange(cursor, cursor)
        pendingCursorRef.current = undefined
      }
    }
  }, [props.draft, focused])

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
  const { dragging, dropState, onDragEnter, onDragOver, onDragLeave, onDrop } = useComposerDragDrop({
    disabled: props.disabled,
    attachmentsDisabled: props.attachmentsDisabled === true,
    ingestFiles,
  })
  const configuration = props.configuration
  const onConfigurationChange = props.onConfigurationChange
  const onCommand = props.onCommand
  const models = props.models ?? EMPTY_MODELS
  const modelFailures = props.modelFailures ?? EMPTY_MODEL_FAILURES
  // Keep model availability visible, but let DSH rc.2 decide whether the
  // runtime can serve a prompt so it can return an actionable provider error.
  const modelUnavailable = props.modelRoutable === false
  const presets = props.presets ?? EMPTY_PRESETS
  const editorContext = props.editorContext ?? EMPTY_EDITOR_CONTEXT
  const editorContextAvailableKinds = props.editorContextAvailableKinds ?? EMPTY_EDITOR_CONTEXT_KINDS
  const {
    commandQuery,
    permissionPresets,
    commandArgumentOptions,
    menuRows,
    commandPaletteSelection,
    referenceToken,
    referenceKey,
    menuOpen,
    referenceMenuOpen,
    menuHighlight,
    menuDismissed,
    highlight,
    referenceHighlightValue,
    commandListboxOpen,
    referenceListboxOpen,
    freeformCommand,
    setMenuHighlight,
    setMenuDismissed,
    setReferenceCursor,
    setReferenceHighlight,
    setReferenceDismissed,
    pickMenuRow,
    adjudicateCommandLine,
    applyCommandSelection,
    insertCommand,
    selectReference,
    commandSubmitting,
    cancelCommand,
  } = useComposerMenuState(
    { ...props, submissionBlocked: isSubmitting },
    {
      setPendingCursor: (cursor) => {
        pendingCursorRef.current = cursor
      },
      closeExtras: () => changeExtrasOpen(false),
      focusTextarea: () => textareaRef.current?.focus(),
    },
  )
  const sending = isSubmitting || commandSubmitting
  const stoppable = sending || props.running
  const cancel = (): void => {
    cancelSubmission()
    cancelCommand()
    if (!commandSubmitting && (!isSubmitting || isDirectSubmitting)) props.onCancel()
  }
  const suggestionAnnouncement = menuOpen
    ? menuRows.length > 0
      ? t('composer.commandSuggestionsOpen', { count: menuRows.length })
      : freeformCommand !== undefined && commandArgumentOptions.length === 0
        ? t('composer.commandSuggestionsFreeform', { command: freeformCommand.name })
        : t('composer.commandSuggestionsEmpty')
    : referenceMenuOpen
      ? props.referenceLoading === true
        ? t('composer.referenceSuggestionsLoading')
        : (props.references?.length ?? 0) > 0
          ? t('composer.referenceSuggestionsOpen', { count: props.references?.length ?? 0 })
          : t('composer.referenceSuggestionsEmpty')
      : ''
  const openFileCandidates = useMemo(
    () => orderOpenFileCandidates(props.openFileCandidates, props.preferredOpenFileId),
    [props.openFileCandidates, props.preferredOpenFileId],
  )
  const defaultOpenFileId = useMemo(
    () =>
      props.preferredOpenFileId !== undefined &&
      openFileCandidates.some((candidate) => candidate.id === props.preferredOpenFileId)
        ? props.preferredOpenFileId
        : openFileCandidates.find((candidate) => candidate.active)?.id,
    [openFileCandidates, props.preferredOpenFileId],
  )
  const handleSessionCommand = useCallback(
    (command: string): void => {
      void Promise.resolve(onCommand?.(command)).catch(() => undefined)
    },
    [onCommand],
  )
  const renderSessionControls = (
    surface: NonNullable<SessionControlsProps['surface']>,
  ): ReactElement | null => {
    if (configuration === undefined || onConfigurationChange === undefined) return null
    const controlProps: SessionControlsProps = {
      configuration,
      models,
      modelFailures,
      presets,
      permissionPresets,
      ...(props.configurationDraft === undefined ? {} : { configurationDraft: props.configurationDraft }),
      ...(props.defaultPermissionPreset === undefined
        ? {}
        : { defaultPermissionPreset: props.defaultPermissionPreset }),
      disabled: props.configurationDisabled ?? props.disabled,
      presetMutable: props.presetMutable === true,
      surface,
      ...(props.commands === undefined ? {} : { commands: props.commands }),
      ...(props.modelLoading === undefined ? {} : { modelLoading: props.modelLoading }),
      ...(props.modelError === undefined ? {} : { modelError: props.modelError }),
      ...(props.modelCurrent === undefined ? {} : { modelCurrent: props.modelCurrent }),
      ...(props.presetSelectionEnabled === undefined
        ? {}
        : { presetSelectionEnabled: props.presetSelectionEnabled }),
      ...(props.onModelRetry === undefined ? {} : { onModelRetry: props.onModelRetry }),
      ...(props.estimatedContextTokens === undefined
        ? {}
        : { estimatedContextTokens: props.estimatedContextTokens }),
      ...(props.contextWindowTokens === undefined ? {} : { contextWindowTokens: props.contextWindowTokens }),
      ...(props.contextBreakdown === undefined ? {} : { contextBreakdown: props.contextBreakdown }),
      ...(props.promptMode === undefined ? {} : { promptMode: props.promptMode }),
      ...(props.modelPickerOpenRequest === undefined
        ? {}
        : { modelPickerOpenRequest: props.modelPickerOpenRequest }),
      ...(props.onPromptModeChange === undefined ? {} : { onPromptModeChange: props.onPromptModeChange }),
      onChange: onConfigurationChange,
      onCommand: handleSessionCommand,
    }
    return <SessionControls {...controlProps} />
  }

  const deleteEmbeddedReference = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false
    const textarea = textareaRef.current
    if (textarea === null || textarea.selectionStart !== textarea.selectionEnd) return false
    const range = embeddedReferenceRange(props.draft, textarea.selectionStart, event.key === 'Backspace')
    if (range === undefined) return false
    event.preventDefault()
    props.onDraftChange(props.draft.slice(0, range.start) + props.draft.slice(range.end))
    pendingCursorRef.current = range.start
    return true
  }

  const deleteEmbeddedReferenceBeforeInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    const inputType = (event.nativeEvent as InputEvent).inputType
    const backwards = inputType === 'deleteContentBackward'
    if (!backwards && inputType !== 'deleteContentForward') return
    const textarea = textareaRef.current
    if (textarea === null || textarea.selectionStart !== textarea.selectionEnd) return
    const range = embeddedReferenceRange(props.draft, textarea.selectionStart, backwards)
    if (range === undefined) return
    event.preventDefault()
    props.onDraftChange(props.draft.slice(0, range.start) + props.draft.slice(range.end))
    pendingCursorRef.current = range.start
  }

  /** True while an IME owns the key: its Enter/Escape pick or cancel a
   * candidate instead of acting on the composer. `keyCode` 229 is the legacy
   * composition signal engines emit without `isComposing`. */
  const isComposingKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
    composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (sending && event.key === 'Enter' && !event.shiftKey && !isComposingKey(event)) {
      event.preventDefault()
      return
    }
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
    if (referenceMenuOpen && !isComposingKey(event)) {
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
    if (menuOpen && !isComposingKey(event)) {
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
    if (isComposingKey(event)) return
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
      steerQueuedInputs()
      return
    }
    submit(resolveSubmitMode(props.running, accelerated, props.busyEnter ?? 'queue'))
  }
  const previews = props.attachmentPreviews ?? EMPTY_ATTACHMENT_PREVIEWS
  return (
    <UnifiedComposer
      ref={composerRef}
      className={`dsh-composer${dragging ? ' dsh-composer--dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseDown={(event) => {
        if (!focused || event.button !== 0 || props.disabled || inputBlocked || event.defaultPrevented) return
        const target = event.target
        if (
          !(target instanceof Element) ||
          target.closest(
            'button, a, input, select, textarea, [role="button"], [tabindex], [role="dialog"], [role="menu"], [role="listbox"]',
          ) !== null
        )
          return
        event.preventDefault()
        if (document.activeElement !== textareaRef.current)
          textareaRef.current?.focus({ preventScroll: true })
      }}
      onSubmit={(event) => {
        event.preventDefault()
        // The primary button is Stop while running (input stays free); the
        // implicit form submit only exists for the idle Send path.
        if (!props.running && !sending) submit('queue')
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
      <ComposerAttachmentsRail
        attachments={props.attachments}
        previews={previews}
        railRef={attachmentRailRef}
        scrollable={attachmentRailScrollable}
        onOpenPreview={openPreview}
        onRemove={(uri) => {
          if (previewUri === uri) closePreview()
          props.onRemoveAttachment(uri)
        }}
      />
      <EditorContextRail
        items={editorContext}
        disabled={props.disabled || inputBlocked || props.attachmentsDisabled === true}
        loading={props.editorContextLoading ?? false}
        {...(props.onRemoveEditorContext === undefined ? {} : { onRemove: props.onRemoveEditorContext })}
        {...(props.onPreviewEditorContext === undefined ? {} : { onPreview: props.onPreviewEditorContext })}
      />
      {modelUnavailable ? (
        <p className="dsh-composer__model-block" role="status">
          {t('composer.modelUnavailable')}
        </p>
      ) : null}
      <div className="dsh-composer__input-shell">
        <ComposerQuickTools
          disabled={props.disabled || inputBlocked || props.attachmentsDisabled === true}
          loading={props.editorContextLoading === true}
          availableKinds={editorContextAvailableKinds}
          onPickAttachment={() => {
            changeExtrasOpen(false)
            props.onPickAttachment()
          }}
          {...(props.onCaptureEditorContext === undefined ? {} : { onCapture: props.onCaptureEditorContext })}
        />
        <textarea
          ref={textareaRef}
          className="dsh-composer__textarea"
          aria-label={t('composer.prompt')}
          aria-describedby={focused ? hintId : undefined}
          value={props.draft}
          disabled={inputBlocked}
          {...(menuOpen || referenceMenuOpen ? { 'aria-autocomplete': 'list' } : {})}
          {...(commandListboxOpen
            ? { 'aria-haspopup': 'listbox', 'aria-controls': COMMAND_MENU_ID }
            : referenceListboxOpen
              ? { 'aria-haspopup': 'listbox', 'aria-controls': REFERENCE_MENU_ID }
              : {})}
          {...(referenceListboxOpen && referenceHighlightValue !== undefined
            ? { 'aria-activedescendant': referenceMenuOptionId(referenceHighlightValue) }
            : commandListboxOpen && highlight !== undefined
              ? { 'aria-activedescendant': commandMenuOptionId(highlight) }
              : {})}
          onChange={(event) => {
            const value = event.target.value
            fitComposerTextarea(event.currentTarget, focused ? { minimum: 42, maximum: 240 } : undefined)
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
          onBeforeInput={deleteEmbeddedReferenceBeforeInput}
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
          placeholder={t(focused ? 'composer.focusedPlaceholder' : 'composer.placeholder')}
          rows={1}
        />
        <span
          className="dsh-sr-only dsh-composer__suggestion-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {suggestionAnnouncement}
        </span>
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
            {...(props.onOpenSkillDocument === undefined
              ? {}
              : { onOpenSkillDocument: props.onOpenSkillDocument })}
            commands={props.commands}
            query={commandQuery}
            rows={menuRows}
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
          <ComposerExtrasMenu
            open={extrasOpen}
            disabled={props.disabled || inputBlocked}
            {...(props.editorContext === undefined ? {} : { count: props.editorContext.length })}
            label={t('composer.context')}
            anchorRef={composerRef}
            onOpenChange={changeExtrasOpen}
          >
            <ComposerAttachmentActions
              disabled={props.disabled || inputBlocked}
              attachmentsDisabled={props.attachmentsDisabled === true}
              openFileCandidates={openFileCandidates}
              defaultOpenFileId={defaultOpenFileId}
              openFilePickerOpen={props.openFilePickerOpen}
              openFilePickerLoading={props.openFilePickerLoading}
              attachedOpenFileIds={props.attachedOpenFileIds}
              {...(props.attachingOpenFileId === undefined
                ? {}
                : { attachingOpenFileId: props.attachingOpenFileId })}
              onToggleOpenFilePicker={props.onToggleOpenFilePicker}
              onSelectOpenFile={(candidateId) => {
                changeExtrasOpen(false)
                if (props.openFilePickerOpen) props.onToggleOpenFilePicker()
                props.onSelectOpenFile(candidateId)
              }}
            />
            {props.commands === undefined || props.commands.length === 0 ? null : (
              <div className="dsh-composer__extras-section">
                <ComposerCommandActions
                  commands={props.commands}
                  disabled={props.disabled || inputBlocked}
                  onInsert={insertCommand}
                />
              </div>
            )}
            {configuration === undefined || onConfigurationChange === undefined ? null : (
              <div className="dsh-composer__extras-section">{renderSessionControls('secondary')}</div>
            )}
          </ComposerExtrasMenu>
          {renderSessionControls('permission')}
          <span
            id={hintId}
            className={focused ? 'dsh-sr-only' : 'dsh-composer__hint'}
            title={props.running ? t('composer.runningHint') : t('composer.idleHint')}
          >
            {props.running ? t('composer.runningHintShort') : t('composer.idleHintShort')}
          </span>
        </div>
        {configuration === undefined || onConfigurationChange === undefined ? null : (
          <div className="dsh-composer__toolbar-controls">{renderSessionControls('model')}</div>
        )}
        <span className="dsh-composer__toolbar-balance" aria-hidden="true" />
        {props.running && sending && !isDirectSubmitting ? (
          <button
            className="dsh-button dsh-button--danger"
            type="button"
            aria-label={t('composer.stopResponse')}
            title={t('composer.stopResponse')}
            onClick={props.onCancel}
            disabled={props.disabled}
          >
            <Icon name="stop" />
            {t('composer.stopResponse')}
          </button>
        ) : null}
        <button
          className={`dsh-button dsh-composer__submit ${stoppable ? 'dsh-button--danger' : 'dsh-button--primary'}`}
          type={stoppable ? 'button' : 'submit'}
          onClick={stoppable ? cancel : undefined}
          aria-label={
            sending
              ? t('composer.cancelSend')
              : props.running
                ? t('composer.stopResponse')
                : t('composer.sendMessage')
          }
          title={
            sending
              ? t('composer.cancelSend')
              : props.running
                ? t('composer.stopResponse')
                : t('composer.sendMessage')
          }
          aria-busy={sending}
          onMouseDown={(event) => {
            if (!focused || event.button !== 0 || props.disabled) return
            event.preventDefault()
            textareaRef.current?.focus({ preventScroll: true })
          }}
          disabled={
            props.disabled ||
            (!stoppable && inputBlocked) ||
            (!stoppable && props.draft.trim() === '' && props.attachments.length === 0)
          }
        >
          {sending ? (
            <svg className="dsh-composer__sending" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="m9 9 6 6m0-6-6 6" />
            </svg>
          ) : (
            <Icon name={props.running ? 'stop' : focused ? 'arrow-up' : 'send'} />
          )}
          <span className="dsh-composer__send-label">
            {stoppable ? t('composer.stop') : t('composer.send')}
          </span>
        </button>
      </div>
      {previewedAttachment === undefined ? null : (
        <AttachmentLightbox
          name={previewedAttachment.name}
          src={previews[previewedAttachment.uri]}
          unavailable={
            previews[previewedAttachment.uri] === undefined &&
            props.attachmentPreviewFailures?.includes(previewedAttachment.uri) === true
          }
          onClose={closePreview}
        />
      )}
    </UnifiedComposer>
  )
})
