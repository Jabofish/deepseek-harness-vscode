import type { DynamicCommand } from '@dsh-vscode/domain'

/** UI-only registration for a bare-command popup. It decorates a command
 * already present in the host directory; it never changes the DSH wire
 * descriptor or invents a command in the absence of a host row. */
export interface PopupSelectRegistration {
  readonly command: string
  readonly onOpen: () => void
}

export type CommandDispatchKind = 'execute' | 'popupSelect' | 'leadingInput'

export class PopupSelectRegistry {
  private readonly registrations = new Map<string, PopupSelectRegistration>()

  public register(registration: PopupSelectRegistration): () => void {
    const command = normalizeCommandName(registration.command)
    if (command === undefined) throw new Error('A popup-select command must use a valid command name.')
    const normalized = { ...registration, command }
    if (this.registrations.has(command))
      throw new Error(`Popup-select command already registered: ${command}`)
    this.registrations.set(command, normalized)
    return () => {
      if (this.registrations.get(command) === normalized) this.registrations.delete(command)
    }
  }

  public clear(): void {
    this.registrations.clear()
  }

  public get(command: string): PopupSelectRegistration | undefined {
    return this.registrations.get(command.toLocaleLowerCase())
  }
}

/** Derive the UI dispatch kind per command dispatch, matching the upstream
 * rule: registered bare-command UI is popupSelect, host input is
 * leadingInput, and the remaining host command is execute. */
export function commandDispatchKind(
  command: DynamicCommand,
  popupSelects: PopupSelectRegistry | undefined,
): CommandDispatchKind {
  if (popupSelects?.get(command.name) !== undefined) return 'popupSelect'
  if (command.input !== undefined) return 'leadingInput'
  return 'execute'
}

function normalizeCommandName(value: string): string | undefined {
  const normalized = value.trim().toLocaleLowerCase()
  return /^[a-z][a-z0-9_-]*$/u.test(normalized) ? normalized : undefined
}
