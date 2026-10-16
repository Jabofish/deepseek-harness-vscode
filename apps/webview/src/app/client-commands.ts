import type { DynamicCommand } from '@dsh-vscode/domain'
import { translate } from '../i18n.js'

/**
 * Client-owned slash commands. They are UX affordances the Webview handles
 * itself: the line is claimed as soon as the composer sees it and never travels
 * to DSH as a prompt. They are still advertised as directory rows so the
 * palette and the Enter adjudication know they exist, exactly like `/model`.
 */
export const MOVETO_COMMAND_NAME = 'moveto'

export type MovetoTarget = 'editor' | 'sidebar'

/** What the client command did, or why it could not run. */
export type MovetoOutcome = MovetoTarget | 'unknown-target' | 'no-session'

/** `/moveto`, `/moveto:…` and `/moveto …` are all the same client command. */
const MOVETO_PREFIX = /^\/moveto(?=:|[ \t]|$)/u
/** The single-line short form `/moveto:<target>`; the shared grammar has no `:`. */
const MOVETO_SHORT_FORM = /^\/moveto:([^ \t]*)[ \t]*$/u
const MOVETO_TARGET = /^\/moveto(?::|[ \t]+)([^ \t]*)[ \t]*$/u

/**
 * The short form is rewritten into the grammar's only shape (`/moveto editor`)
 * before any parser sees it. The rewrite is deliberately narrow: no other
 * client or DSH command accepts a colon, and multi-line drafts are never
 * rewritten because they are ordinary prompts.
 */
export function normalizeClientCommandText(text: string): string {
  if (text.includes('\n')) return text
  const match = MOVETO_SHORT_FORM.exec(text.trim())
  if (match === null) return text
  const target = (match[1] ?? '').trim()
  return target === '' ? `/${MOVETO_COMMAND_NAME}` : `/${MOVETO_COMMAND_NAME} ${target}`
}

/**
 * Any `/moveto…` line is client-owned, including a malformed target: an
 * unknown target must fail locally instead of being spelled as a prompt.
 */
export function isMovetoCommandLine(line: string): boolean {
  if (line.includes('\n')) return false
  return MOVETO_PREFIX.test(line.trim())
}

export function movetoTargetOf(line: string): MovetoTarget | undefined {
  const match = MOVETO_TARGET.exec(line.trim())
  if (match === null) return undefined
  const target = (match[1] ?? '').trim().toLocaleLowerCase()
  return target === 'editor' || target === 'sidebar' ? target : undefined
}

export function movetoCommandRow(): DynamicCommand {
  return {
    name: MOVETO_COMMAND_NAME,
    description: translate('commands.movetoDescription'),
    input: { hint: '[editor|sidebar]' },
    source: 'plugin',
  }
}
