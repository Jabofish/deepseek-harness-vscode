import { describe, expect, it } from 'vitest'
import { type WebviewRequest, webviewRequestSchema } from '@dsh-vscode/webview-protocol'
import { requiresTrustedWorkspace } from './workspace-guards.js'

type LiteralOption = { readonly shape: { readonly type: { readonly value: string } } }

const requestTypes = (): WebviewRequest['type'][] =>
  (webviewRequestSchema as unknown as { options: readonly LiteralOption[] }).options.map(
    (option) => option.shape.type.value as WebviewRequest['type'],
  )

/**
 * The only routes that may run while a project folder is untrusted: the
 * handshake, connection and read-only DSH queries that never touch workspace
 * files, plus disposal of handles the user already granted. Everything else
 * must be classified in the trust guard.
 */
const routesAllowedWhileUntrusted = [
  'app.ready',
  'attachment.release',
  'connection.configure',
  'connection.retry',
  'diagnostics.show',
  'diagnostics.snapshot',
  'extensionSettings.read',
  'models.discover',
  'models.list',
  'models.session.list',
  'plugin.inventory',
  'preset.list',
  'providers.list',
  'runtime.action',
  'runtime.update.check',
  'runtime.update.install',
  'session.list',
  'settings.read',
  'view.openLink',
  'view.showInFolder',
  'workspace.addFolder',
  'workspace.list',
] as const satisfies readonly WebviewRequest['type'][]

const allowed = new Set<string>(routesAllowedWhileUntrusted)

describe('workspace trust route classification', () => {
  it('classifies every protocol route explicitly instead of relying on the default', () => {
    const types = requestTypes()
    const unclassified = types.filter((type) => !allowed.has(type) && !requiresTrustedWorkspace(type))
    expect(unclassified).toStrictEqual([])
  })

  it('keeps the allowlist aligned with routes the protocol still declares', () => {
    const types = new Set<string>(requestTypes())
    const stale = routesAllowedWhileUntrusted.filter((type) => !types.has(type))
    expect(stale).toStrictEqual([])
  })

  it('does not widen the set of routes that run in an untrusted workspace', () => {
    const open = requestTypes()
      .filter((type) => !requiresTrustedWorkspace(type))
      .map((type) => type as string)
    expect(open.sort()).toStrictEqual([...allowed].sort())
  })

  it('requires trust for every route that reaches workspace files, tools or credentials', () => {
    const highRisk: readonly WebviewRequest['type'][] = [
      'session.sendPrompt',
      'session.create',
      'attachment.pick',
      'attachment.read',
      'command.execute',
      'job.kill',
      'skill.openDocument',
      'preset.openDocument',
      'provider.secret.configure',
      'plugin.credential.configure',
      'interaction.permission.respond',
      'settings.mutate',
      'workspace.remove',
      'session.export',
    ]
    for (const type of highRisk) expect(requiresTrustedWorkspace(type)).toBe(true)
  })
})
