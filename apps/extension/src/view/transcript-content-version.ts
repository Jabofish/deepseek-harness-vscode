import { createHash, type Hash } from 'node:crypto'
import type { TimelineNode } from '@dsh-vscode/timeline'

type TextNode = Extract<TimelineNode, { kind: 'assistant-message' | 'reasoning' }>
interface TextHashes {
  readonly markdown: Hash
  readonly reasoning: Hash
}

/** Fingerprint complete bodies, never their lossy transport previews. */
export class TranscriptContentVersions {
  private readonly keys = new WeakMap<TimelineNode, string>()
  private readonly text = new WeakMap<TimelineNode, TextHashes>()

  public key(node: TimelineNode): string {
    const known = this.keys.get(node)
    if (known !== undefined) return known
    let serialized: string
    if (node.kind === 'assistant-message' || node.kind === 'reasoning') {
      let hashes = this.text.get(node)
      if (hashes === undefined) {
        hashes = {
          markdown: createHash('sha256').update(node.markdown, 'utf16le'),
          reasoning: createHash('sha256').update(
            node.kind === 'assistant-message' ? (node.reasoning?.markdown ?? '') : '',
            'utf16le',
          ),
        }
        this.text.set(node, hashes)
      }
      const { markdown: _markdown, ...rest } = node
      void _markdown
      const metadata =
        node.kind === 'assistant-message' && node.reasoning !== undefined
          ? { ...rest, reasoning: { ...node.reasoning, markdown: '' } }
          : rest
      serialized = JSON.stringify([
        metadata,
        hashes.markdown.copy().digest('hex'),
        hashes.reasoning.copy().digest('hex'),
      ])
    } else serialized = JSON.stringify(node)
    const key = createHash('sha256').update(serialized).digest('hex')
    this.keys.set(node, key)
    return key
  }

  /** Only a proven append uses the old state; retained nodes never mutate. */
  public append(previous: TimelineNode, next: TimelineNode, suffix: TextNode): void {
    const hashes = this.text.get(previous)
    if (hashes === undefined) return
    this.text.set(next, {
      markdown: hashes.markdown.copy().update(suffix.markdown, 'utf16le'),
      reasoning: hashes.reasoning
        .copy()
        .update(suffix.kind === 'assistant-message' ? (suffix.reasoning?.markdown ?? '') : '', 'utf16le'),
    })
  }
}
