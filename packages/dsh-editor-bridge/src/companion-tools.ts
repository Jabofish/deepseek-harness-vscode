import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  EditorCompanionError,
  isEditorCompanionRequest,
  isEditorCompanionValue,
  type EditorCompanionRequest,
  type EditorCompanionValue,
} from '@dsh-vscode/domain'
import type { EditorCompanionBroker } from './companion-broker.js'
import { explainFailure } from './failures.js'

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
  dirty: { ...boolean, description: 'VS Code unsaved-buffer flag; not a comparison with disk.' },
  range,
  text: { type: 'string' },
  truncated: boolean,
})
const proposalOutput = object(
  {
    kind: { type: 'string', const: 'proposal' },
    proposalId: string,
    relativePath: string,
    status: {
      type: 'string',
      enum: ['pending', 'applied', 'uncertain', 'reverted', 'declined', 'stale', 'cancelled'],
      description:
        'uncertain means the native reply failed after dispatch. Read the file before any retry; the undo record is retained.',
    },
    version: integer,
    saved: {
      type: 'boolean',
      description:
        'For applied/reverted: true = saved; false = buffer changed but retained unsaved or save failed. Do not repeat an applied edit.',
    },
  },
  ['kind', 'proposalId', 'relativePath', 'status', 'version'],
)
const path = {
  type: 'string',
  description:
    'Workspace-relative path; prefix the root name in multi-root workspaces. Omit for the active editor. Use paths returned by editor tools.',
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
      'Read buffer text, including unsaved changes. Returns up to 200 lines / 16,384 UTF-16 units. Coordinates are 1-based; range.end is exclusive. If truncated, continue with startLine=range.end.line, startColumn=range.end.column and expectedVersion=version. A start past EOF fails.',
    parameters: object(
      {
        path,
        startLine: { ...integer, description: 'First line, 1-based.' },
        startColumn: { ...integer, description: 'First UTF-16 column, 1-based.' },
        endLine: { ...integer, description: 'Last line, inclusive; still bounded by the per-call limit.' },
        expectedVersion: integer,
      },
      [],
    ),
    output: documentOutput,
  },
  {
    name: 'vscode_read_selection',
    kind: 'selection',
    description:
      'Read the active editor selection, including unsaved changes. An empty selection returns empty text. Coordinates are 1-based UTF-16; range.end is exclusive.',
    parameters: object({}),
    output: documentOutput,
  },
  {
    name: 'vscode_get_diagnostics',
    kind: 'diagnostics',
    description:
      'Read cached VS Code diagnostics: severity, message, source, code and range. Results may lag edits; this is not a build check.',
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
      'Find document symbols. Set query to search workspace symbols instead. Requires a language provider; excludes locations outside the workspace.',
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
      'Find definitions at 1-based UTF-16 line/column. Requires a language provider; excludes locations outside the workspace.',
    parameters: object({ path, line: integer, column: integer, limit }, ['line', 'column']),
    output: listOutput('locations', object(location)),
  },
  {
    name: 'vscode_find_references',
    kind: 'references',
    description:
      'Find references at 1-based UTF-16 line/column. Requires a language provider; excludes locations outside the workspace.',
    parameters: object({ path, line: integer, column: integer, limit }, ['line', 'column']),
    output: listOutput('locations', object(location)),
  },
  {
    name: 'vscode_open_file',
    kind: 'open',
    description:
      'Open a workspace file at optional 1-based line/column without taking keyboard focus. Omit path for the active editor.',
    parameters: object({ path, line: integer, column: integer }, []),
    output: object({ kind: { type: 'string', const: 'opened' }, relativePath: string }),
  },
  {
    name: 'vscode_propose_edit',
    kind: 'propose',
    description:
      'Apply undoable edits to a document of at most 262,144 UTF-16 units before and after editing. Up to 64 edits / 65,536 replacement UTF-16 units per call. Initially clean buffers are saved; existing unsaved user changes remain unsaved. First read the file; use its relativePath and version as path and expectedVersion. Ranges are 1-based UTF-16, end exclusive. applied means changed; saved=false means retained unsaved or save failed, not edit failure. For uncertain outcomes, read the file before retrying.',
    parameters: object(
      {
        path: {
          ...path,
          description: 'Required: relativePath from read_document. Untitled buffers cannot be edited.',
        },
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
      'Look up an edit using its returned proposalId. Old receipts may expire. An unknown ID does not indicate a disconnected editor.',
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
        const target = (args as { path?: unknown }).path
        // A label the model may have seen in a read result: say why it cannot be used.
        if (typeof target === 'string' && target.startsWith('untitled:'))
          throw new Error(
            'Untitled buffers have no path. Omit path to read the active editor; they cannot be edited.',
          )
        const request: unknown = { ...args, kind: tool.kind }
        if (!isEditorCompanionRequest(request)) throw new Error('Invalid editor tool arguments.')
        let value: EditorCompanionValue
        try {
          value = await broker.read(exec.agent?.session.id, request, exec.signal)
        } catch (error) {
          if (error instanceof EditorCompanionError)
            throw new Error(`[editor:${error.reason}] ${explainFailure(error.reason, request.kind)}`, {
              cause: error,
            })
          throw error
        }
        if (!isEditorCompanionValue(value)) throw new Error('Invalid editor tool result.')
        return value
      },
    })
}
