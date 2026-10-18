import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AgentConfiguration, DynamicCommand, PromptAttachment } from '@dsh-vscode/domain'
import type { ReferenceCandidate } from '../../app/store.js'
import {
  commandMenuRows,
  firstCommandPaletteSelection,
  parsePaletteQuery,
  type CommandArgumentOption,
  type CommandMenuRow,
  type CommandPaletteSelection,
} from '../commands/CommandPalette.js'
import { commandDispatchKind, type PopupSelectRegistry } from '../commands/popupSelectRegistry.js'
import { normalizeClientCommandText } from '../../app/client-commands.js'
import { permissionOptions } from './SessionControls.js'
import {
  commandInputOptions,
  referenceMention,
  referenceQueryToken,
  slashCommandQuery,
} from './composer-input.js'

const EMPTY_COMMANDS: readonly DynamicCommand[] = []
const EMPTY_COMMAND_MENU_ROWS: readonly CommandMenuRow[] = []
const EMPTY_STRING_LIST: readonly string[] = []

interface ComposerMenuProps {
  readonly draft: string
  readonly attachments: readonly PromptAttachment[]
  readonly configuration?: AgentConfiguration | undefined
  readonly permissionPresets?: readonly string[]
  readonly commands?: readonly DynamicCommand[]
  readonly popupSelects?: PopupSelectRegistry
  readonly references?: readonly ReferenceCandidate[]
  readonly referenceLoading?: boolean
  readonly onCommand?: (command: string, attachments?: readonly PromptAttachment[]) => Promise<void> | void
  readonly onPopupSelect?: (command: string) => void
  readonly onCommandQueryChange?: (query: string | undefined) => void
  readonly onReferenceQueryChange?: (query: string | undefined, quoted: boolean) => void
  readonly onDraftChange: (value: string | ((current: string) => string)) => void
}

interface ComposerMenuActions {
  readonly setPendingCursor: (cursor: number) => void
  readonly closeExtras: () => void
  readonly focusTextarea: () => void
}

/** Command/reference suggestions and picks; keyboard arbitration stays in Composer. */
export function useComposerMenuState(
  props: ComposerMenuProps,
  actions: ComposerMenuActions,
): {
  readonly commandQuery: string | undefined
  readonly permissionPresets: readonly string[]
  readonly commandArgumentOptions: readonly CommandArgumentOption[]
  readonly menuRows: readonly CommandMenuRow[]
  readonly commandPaletteSelection: CommandPaletteSelection | undefined
  readonly referenceToken: ReturnType<typeof referenceQueryToken>
  readonly referenceKey: string | undefined
  readonly menuOpen: boolean
  readonly referenceMenuOpen: boolean
  readonly menuHighlight: number | undefined
  readonly menuDismissed: string | undefined
  readonly highlight: number | undefined
  readonly referenceHighlightValue: number | undefined
  readonly commandListboxOpen: boolean
  readonly referenceListboxOpen: boolean
  readonly freeformCommand: DynamicCommand | undefined
  readonly setMenuHighlight: Dispatch<SetStateAction<number | undefined>>
  readonly setMenuDismissed: Dispatch<SetStateAction<string | undefined>>
  readonly setReferenceCursor: Dispatch<SetStateAction<number>>
  readonly setReferenceHighlight: Dispatch<SetStateAction<number | undefined>>
  readonly setReferenceDismissed: Dispatch<SetStateAction<string | undefined>>
  readonly pickMenuRow: (row: CommandMenuRow) => void
  readonly adjudicateCommandLine: (command: DynamicCommand, args: string) => void
  readonly applyCommandSelection: (selection: CommandPaletteSelection, executeNoInput: boolean) => void
  readonly insertCommand: (command: DynamicCommand) => void
  readonly selectReference: (candidate: ReferenceCandidate) => void
} {
  const commandSubmitInFlight = useRef(false)
  const configuration = props.configuration
  const onCommand = props.onCommand
  // Official input-trigger menu state: the highlight rides
  // aria-activedescendant, and Escape dismisses until the query changes.
  const [menuHighlight, setMenuHighlight] = useState<number | undefined>(undefined)
  const [menuHighlightFor, setMenuHighlightFor] = useState<string | undefined>(undefined)
  const [menuDismissed, setMenuDismissed] = useState<string | undefined>(undefined)
  const [referenceCursor, setReferenceCursor] = useState(() => props.draft.length)
  const [referenceHighlight, setReferenceHighlight] = useState<number | undefined>(undefined)
  const [referenceHighlightFor, setReferenceHighlightFor] = useState<string | undefined>(undefined)
  const [referenceDismissed, setReferenceDismissed] = useState<string | undefined>(undefined)
  const commandQuery = useMemo(() => slashCommandQuery(props.draft), [props.draft])
  const permissionPresets = props.permissionPresets ?? EMPTY_STRING_LIST
  const availableCommandPermissionPresets = useMemo(
    () => permissionOptions(configuration?.permissionPreset ?? '', permissionPresets),
    [configuration?.permissionPreset, permissionPresets],
  )
  const commands = props.commands ?? EMPTY_COMMANDS
  const commandArgumentOptions = useMemo(
    () => commandInputOptions(commandQuery, commands, availableCommandPermissionPresets),
    [availableCommandPermissionPresets, commandQuery, commands],
  )
  const menuRows = useMemo(
    () =>
      commandQuery === undefined || props.commands === undefined
        ? EMPTY_COMMAND_MENU_ROWS
        : commandMenuRows(commandQuery, commands, commandArgumentOptions),
    [commandArgumentOptions, commandQuery, commands, props.commands],
  )
  const commandPaletteSelection = useMemo(
    () =>
      commandQuery === undefined || props.commands === undefined
        ? undefined
        : firstCommandPaletteSelection(commandQuery, commands, commandArgumentOptions, menuRows),
    [commandArgumentOptions, commandQuery, commands, menuRows, props.commands],
  )
  const referenceToken = useMemo(
    () => referenceQueryToken(props.draft, referenceCursor),
    [props.draft, referenceCursor],
  )
  const referenceKey = useMemo(
    () =>
      referenceToken === undefined
        ? undefined
        : `${referenceToken.start}:${referenceToken.end}:${referenceToken.quoted ? 'quoted' : 'plain'}:${referenceToken.query}`,
    [referenceToken],
  )
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
  const commandListboxOpen = menuOpen && menuRows.length > 0
  const referenceListboxOpen =
    referenceMenuOpen && props.referenceLoading !== true && (props.references?.length ?? 0) > 0
  const parsedCommandQuery = commandQuery === undefined ? undefined : parsePaletteQuery(commandQuery)
  const freeformCommand =
    parsedCommandQuery?.argument === undefined
      ? undefined
      : commands.find((command) => command.name.toLocaleLowerCase() === parsedCommandQuery.name)
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
    // One command gesture at a time. The draft and the command menu survive
    // until the Host accepts the line, so a second Enter during a slow command
    // (compaction) re-enters the same adjudication and would execute the
    // command twice.
    if (commandSubmitInFlight.current) return
    const result = props.attachments.length === 0 ? onCommand(command) : onCommand(command, props.attachments)
    if (result !== undefined && typeof result.then === 'function') {
      commandSubmitInFlight.current = true
      void result.then(
        // The Host owns the submitted line once it is accepted; text typed
        // while the command ran is a different draft and has to survive.
        () => {
          commandSubmitInFlight.current = false
          // The dispatched line may be the normalized form of what the user
          // typed (`/moveto:editor` is submitted as `/moveto editor`), so the
          // draft is compared after the same rewrite.
          props.onDraftChange((current) =>
            normalizeClientCommandText(current).trim() === command ? '' : current,
          )
        },
        () => {
          commandSubmitInFlight.current = false
        },
      )
    } else props.onDraftChange('')
  }
  const insertCommand = (command: DynamicCommand): void => {
    const nextDraft = `/${command.name}${command.input === undefined ? '' : ' '}`
    actions.setPendingCursor(nextDraft.length)
    setReferenceCursor(nextDraft.length)
    setReferenceDismissed(undefined)
    props.onDraftChange(nextDraft)
    props.onCommandQueryChange?.(slashCommandQuery(nextDraft))
    props.onReferenceQueryChange?.(undefined, false)
    actions.closeExtras()
    queueMicrotask(actions.focusTextarea)
  }
  const selectReference = (candidate: ReferenceCandidate): void => {
    if (referenceToken === undefined) return
    const inserted = referenceMention(candidate)
    const next = props.draft.slice(0, referenceToken.start) + inserted + props.draft.slice(referenceToken.end)
    const nextCursor = referenceToken.start + inserted.length
    // The pick rewrites the draft while the textarea keeps focus (the rows
    // preventDefault the mousedown), so React's commit-phase selection restore
    // would leave the caret at the old numeric offset -- inside the inserted
    // mention. Ask the layout effect to reposition it, as the command
    // insertion and mention deletion paths already do.
    actions.setPendingCursor(nextCursor)
    props.onDraftChange(next)
    setReferenceCursor(nextCursor)
    setReferenceHighlight(undefined)
    setReferenceDismissed(undefined)
    const nextToken = referenceQueryToken(next, nextCursor)
    props.onReferenceQueryChange?.(nextToken?.query, nextToken?.quoted ?? false)
  }
  return {
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
  }
}
