import { Composer, type ComposerProps } from './Composer.js'
import { useDraftValue, setDraft } from '../../app/draft-store.js'
import type { ReactElement } from 'react'

/**
 * The composer binding to the shared draft store. The draft value is consumed
 * HERE — not in App — so typing re-renders only this subtree; App and the
 * conversation above it stay out of every keystroke's render pass.
 */
export function ConnectedComposer(props: Omit<ComposerProps, 'draft' | 'onDraftChange'>): ReactElement {
  const draft = useDraftValue()
  return <Composer draft={draft} onDraftChange={setDraft} {...props} />
}
