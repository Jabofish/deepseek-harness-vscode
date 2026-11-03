import { normalizeAlpha171ControlFrame, type Alpha171ControlOutput } from '../alpha171/session-control.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'

/** Validate a complete alpha.3 event batch before publishing any derived frame. */
export function normalizeAlpha223ControlFrame(value: unknown): readonly Alpha171ControlOutput[] | undefined {
  const frame = recordOrUndefined(value)
  if (frame?.type === 'baseline') return normalizeAlpha171ControlFrame(value)
  if (
    frame?.type !== 'projection' ||
    Object.keys(frame).length !== 4 ||
    !Array.isArray(frame.changes) ||
    frame.changes.length === 0 ||
    frame.changes.length > 256
  )
    return undefined
  const keys = new Set<string>()
  const output: Alpha171ControlOutput[] = []
  for (const raw of frame.changes) {
    const change = recordOrUndefined(raw)
    if (
      change === undefined ||
      Object.keys(change).length !== 2 ||
      typeof change.key !== 'string' ||
      keys.has(change.key) ||
      !Object.hasOwn(change, 'val')
    )
      return undefined
    const frames = normalizeAlpha171ControlFrame({
      type: 'projection',
      sessionId: frame.sessionId,
      seq: frame.seq,
      key: change.key,
      value: change.val,
    })
    if (frames === undefined) return undefined
    keys.add(change.key)
    output.push(...frames)
  }
  return output
}
