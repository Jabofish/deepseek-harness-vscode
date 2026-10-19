import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  isEditorCompanionRequest,
  isEditorCompanionValue,
  type EditorCompanionRequest,
} from '@dsh-vscode/domain'
import type { EditorCompanionBroker } from './companion-broker.js'

type Schema = ToolDefinition['output']['schema']
const string = { type: 'string' } as const
const integer = { type: 'integer' } as const
const boolean = { type: 'boolean' } as const
function object(
  properties: Record<string, Schema>,
  required: readonly string[] = Object.keys(properties),
): { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: false } {
  return { type: 'object' as const, properties, required: [...required], additionalProperties: false }
}
const position = object({ line: integer, column: integer })
const range = object({ start: position, end: position })
const location = { relativePath: string, range }
const listOutput = (kind: string, item: Schema): Schema =>
  object({
    kind: { type: 'string', const: kind },
    items: { type: 'array', items: item },
    truncated: boolean,
    excluded: { type: 'integer' },
  })
const documentOutput = object({
  kind: { type: 'string', const: 'document' },
  relativePath: string,
  languageId: string,
  version: integer,
  dirty: boolean,
  range,
  text: { type: 'string' },
  truncated: boolean,
})
const proposalOutput = object({
  kind: { type: 'string', const: 'proposal' },
  proposalId: string,
  relativePath: string,
  status: { type: 'string', enum: ['pending', 'applied', 'declined', 'stale', 'cancelled'] },
  version: integer,
})
const path = {
  type: 'string',
  description:
    'Canonical path relative to the explicitly shared workspace root. Omit to use the active editor.',
} as const
const limit = { type: 'integer' } as const
interface Tool {
  readonly name: string
  readonly kind: EditorCompanionRequest['kind']
  readonly description: string
  readonly parameters: ReturnType<typeof object>
  readonly output: Schema
}
const tools: readonly Tool[] = [
  {
    name: 'vscode_read_document',
    kind: 'document',
    description:
      'Read the current VS Code text buffer, including unsaved edits. Paths are relative to the shared root. Use line ranges to avoid truncation. The result carries a document version; it does not save the document.',
    parameters: object({ path, startLine: integer, endLine: integer, expectedVersion: integer }, []),
    output: documentOutput,
  },
  {
    name: 'vscode_read_selection',
    kind: 'selection',
    description:
      'Read the active editor selection from its current unsaved buffer. Coordinates are one-based UTF-16. Requires explicit content sharing.',
    parameters: object({}),
    output: documentOutput,
  },
  {
    name: 'vscode_get_diagnostics',
    kind: 'diagnostics',
    description:
      'Read bounded, cached VS Code diagnostics for a shared file: message, severity, source, code and range. The timestamp and current document version do not prove language-service or compilation completion.',
    parameters: object({ path, limit }, []),
    output: object({
      kind: { type: 'string', const: 'diagnostics' },
      relativePath: string,
      version: integer,
      capturedAt: string,
      cached: { type: 'boolean', const: true },
      items: {
        type: 'array',
        items: object({
          range,
          severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'] },
          message: string,
          source: string,
          code: string,
        }),
      },
      truncated: boolean,
    }),
  },
  {
    name: 'vscode_find_symbols',
    kind: 'symbols',
    description:
      'Query document symbols, or workspace symbols when query is supplied, through installed VS Code language providers. Only locations inside the explicitly shared root are returned.',
    parameters: object({ path, query: string, limit }, []),
    output: listOutput(
      'symbols',
      object({ ...location, name: string, symbolKind: { type: 'integer' }, container: string }),
    ),
  },
  {
    name: 'vscode_find_definitions',
    kind: 'definitions',
    description:
      'Find definitions through installed VS Code language providers at one-based UTF-16 line/column. Locations outside the shared root are excluded.',
    parameters: object({ path, line: integer, column: integer, limit }, ['line', 'column']),
    output: listOutput('locations', object(location)),
  },
  {
    name: 'vscode_find_references',
    kind: 'references',
    description:
      'Find references through installed VS Code language providers at one-based UTF-16 line/column. Results are bounded and confined to the shared root.',
    parameters: object({ path, line: integer, column: integer, limit }, ['line', 'column']),
    output: listOutput('locations', object(location)),
  },
  {
    name: 'vscode_open_file',
    kind: 'open',
    description:
      'Open a validated shared file at an optional one-based position without taking keyboard focus. Requires navigation permission. Cannot run arbitrary VS Code commands.',
    parameters: object({ path, line: integer, column: integer }, ['path']),
    output: object({ kind: { type: 'string', const: 'opened' }, relativePath: string }),
  },
  {
    name: 'vscode_propose_edit',
    kind: 'propose',
    description:
      'Propose bounded edits against an exact current document version. This does not modify or save any file. The user reviews a native diff and explicitly applies or declines it in VS Code. Query the receipt with vscode_get_edit_result.',
    parameters: object(
      {
        path,
        expectedVersion: integer,
        edits: { type: 'array', items: object({ range, text: { type: 'string' } }) },
      },
      ['path', 'expectedVersion', 'edits'],
    ),
    output: proposalOutput,
  },
  {
    name: 'vscode_get_edit_result',
    kind: 'proposal',
    description:
      'Read the status of an edit proposal belonging to this sharing grant. States distinguish pending, applied, declined, stale and cancelled. A pending proposal is not a completed edit.',
    parameters: object({ proposalId: string }),
    output: proposalOutput,
  },
]
export function registerCompanionTools(ctx: Context, broker: EditorCompanionBroker): void {
  for (const tool of tools)
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: tool.output,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        if (typeof args !== 'object' || args === null || Array.isArray(args) || Object.hasOwn(args, 'kind'))
          throw new Error('Invalid editor tool arguments.')
        const request: unknown = { ...args, kind: tool.kind }
        if (!isEditorCompanionRequest(request)) throw new Error('Invalid editor tool arguments.')
        const value = await broker.read(exec.agent?.session.id, request, exec.signal)
        if (!isEditorCompanionValue(value)) throw new Error('Invalid editor tool result.')
        return value
      },
    })
}
