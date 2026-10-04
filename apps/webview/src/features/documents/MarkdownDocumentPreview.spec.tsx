// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorContextItem } from '@dsh-vscode/domain'
import { MarkdownDocumentPreview, splitDocumentFrontmatter } from './MarkdownDocumentPreview.js'
import { parseFrontmatterFields } from './frontmatter-fields.js'
import { EditorContextChips } from '../composer/EditorContextChips.js'
afterEach(cleanup)
describe('Markdown document frontmatter preview', () => {
  it('keeps authored numbers/collections/aliases and resolves quoted or folded strings without expansion', () => {
    expect(
      parseFrontmatterFields(
        'version: 1.0\ntitle: "Hello"\nsummary: >\n  first\n  second\ntags: &tags [one, two]\ncopy: *tags',
      ),
    ).toEqual([
      { key: 'version', value: '1.0', block: false },
      { key: 'title', value: 'Hello', block: false },
      { key: 'summary', value: 'first second', block: false },
      { key: 'tags', value: '[one, two]', block: true },
      { key: 'copy', value: '*tags', block: true },
    ])
    expect(parseFrontmatterFields('title: one\ntitle: two')).toBeUndefined()
    expect(parseFrontmatterFields('- not\n- a mapping')).toBeUndefined()
    expect(parseFrontmatterFields('x'.repeat(32769))).toBeUndefined()
    expect(parseFrontmatterFields(`nested: ${'['.repeat(40)}x${']'.repeat(40)}`)).toBeUndefined()
    expect(
      parseFrontmatterFields(`nested: [${Array.from({ length: 2100 }, () => 'x').join(',')}]`),
    ).toBeUndefined()
    expect(
      parseFrontmatterFields(Array.from({ length: 65 }, (_, index) => `field${index}: x`).join('\n')),
    ).toBeUndefined()
  })
  it('splits only a complete leading block, including BOM, CRLF and empty fields', () => {
    expect(splitDocumentFrontmatter('\uFEFF---\r\ntitle: Doc\r\n...\r\n# Body')).toEqual({
      source: 'title: Doc',
      body: '# Body',
    })
    expect(splitDocumentFrontmatter('---\n---\nBody')).toEqual({ source: '', body: 'Body' })
    expect(splitDocumentFrontmatter('Text\n---\nkey: value\n---')).toBeUndefined()
    expect(splitDocumentFrontmatter('---\nkey: value')).toBeUndefined()
  })
  it('renders fields and body safely, and preserves invalid YAML verbatim', async () => {
    const view = render(
      <MarkdownDocumentPreview
        text={
          '---\ntitle: "<script>unsafe</script>"\ncount: 1.0\n---\n# Document\n![remote](https://private/image.png)'
        }
      />,
    )
    expect(await screen.findByText('1.0')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Document' })).toBeDefined()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    view.rerender(<MarkdownDocumentPreview text={'---\nbroken: [\n---\n# After'} />)
    expect(screen.getByText('broken: [')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'After' })).toBeDefined()
  })
  it('uses the explicit Host preview flow for a captured Markdown file', async () => {
    const item: EditorContextItem = {
      ref: {
        contextRef: 'context-1',
        workspaceFolderId: 'workspace-1',
        ownerId: 'owner',
        ownerViewId: 'view',
        contextStoreGeneration: 1,
        kind: 'file',
        relativePath: 'docs/guide.md',
        sizeBytes: 50,
        capturedAt: 1000,
        contentHash: 'a'.repeat(64),
        expiresAt: 2000,
      },
      label: 'Guide',
      stale: false,
      previewAvailable: true,
    }
    render(
      <EditorContextChips
        items={[item]}
        disabled={false}
        onRemove={() => {}}
        onPreview={() =>
          Promise.resolve({
            contextRef: 'context-1',
            text: '---\ntitle: Guide metadata\n---\n# Guide body',
            truncated: false,
            expiresAt: 2000,
          })
        }
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview Guide' }))
    expect(await screen.findByText('Guide metadata')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Guide body' })).toBeDefined()
  })
})
