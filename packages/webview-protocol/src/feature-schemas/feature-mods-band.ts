import { z } from 'zod'
import { isBoundedModsBandTree, type ModsBandNode, type ModsBandSnapshot } from '@dsh-vscode/domain'
import { generation } from './feature-shared.js'

const color = z.enum(['yellow', 'red', 'green', 'cyan', 'blue', 'magenta', 'gray', 'white', 'black'])
const displayText = z
  .string()
  .max(4096)
  .refine(
    (text) =>
      !/[\p{Cc}\p{Cf}]|\b[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)[A-Za-z]:[\\/]|(?:^|\s)\/(?!\/)[^\s]+|\\\\|\b(?:set-cookie|cookie|pid|process[_ -]?id)\s*[:=]/iu.test(
        text,
      ),
    'Only redacted display text is allowed.',
  )
export const modsBandActionId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/u)
const spacing = z.number().finite().min(0).max(8)
const node: z.ZodType<ModsBandNode> = z.lazy(() =>
  z.union([
    displayText,
    z
      .object({
        kind: z.literal('box'),
        direction: z.enum(['row', 'column']),
        bordered: z.boolean(),
        color: color.optional(),
        paddingX: spacing,
        paddingY: spacing,
        gap: spacing,
        children: z.array(node).max(512),
      })
      .strict(),
    z
      .object({
        kind: z.literal('text'),
        color: color.optional(),
        bold: z.boolean(),
        dim: z.boolean(),
        italic: z.boolean(),
        underline: z.boolean(),
        children: z.array(node).max(512),
      })
      .strict(),
    z
      .object({
        kind: z.literal('button'),
        label: displayText.max(512),
        hotkey: displayText.max(64).optional(),
        disabled: z.boolean(),
        actionId: modsBandActionId.optional(),
      })
      .strict(),
  ]),
)
export const modsBandSnapshotSchema: z.ZodType<ModsBandSnapshot> = z
  .object({
    generation,
    tree: z
      .unknown()
      .refine(isBoundedModsBandTree, 'Drawing exceeds safe bounds.')
      .pipe(z.array(node).max(512).nullable()),
  })
  .strict()
