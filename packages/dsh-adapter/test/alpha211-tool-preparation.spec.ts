import { describe, expect, it } from 'vitest'

import { ArgumentPreview } from '../src/versions/alpha211/argument-preview.js'
import { createAlpha211SessionNormalizer } from '../src/versions/alpha211/tool-preparation.js'

// dsh-v0.2.1-alpha.1 / 5badb150: llm/llm/src/types.ts and the Session v2 projector.
interface ToolDeltaFrame {
  type: 'session/assistant-stream'
  sessionId: string
  frame: {
    type: 'chunk'
    attemptId: string
    index: number
    revision: number
    turn: number
    step: number
    time: number
    startedAfterSeq: number
    chunk: {
      type: 'tool-call-delta'
      index: number
      id: string
      argumentsDelta: string
      name?: string
    }
  }
}

function delta(
  index: number,
  argumentsDelta: string,
  options: { id?: string; name?: string; attemptId?: string } = {},
): ToolDeltaFrame {
  return {
    type: 'session/assistant-stream',
    sessionId: 's1',
    frame: {
      type: 'chunk',
      attemptId: options.attemptId ?? 'attempt-1',
      index,
      revision: 1,
      turn: 1,
      step: 1,
      time: 1,
      startedAfterSeq: 2,
      chunk: {
        type: 'tool-call-delta',
        index: 0,
        id: options.id ?? 'call-1',
        argumentsDelta,
        ...(options.name === undefined ? {} : { name: options.name }),
      },
    },
  }
}

describe('alpha211 structured argument preparation', () => {
  it('reads only root fields; waits for a completed path and counts decoded UTF-16 through split escapes', () => {
    const normalize = createAlpha211SessionNormalizer()
    expect(normalize(delta(0, '{"file_path":"src/', { name: 'write' }))).not.toHaveProperty('filePath')
    expect(
      normalize(
        delta(1, 'test.ts","description":"Add test","nested":{"content":"ignored"},"content":"a\\uD8'),
      ),
    ).toMatchObject({
      type: 'tool.preparing',
      filePath: 'src/test.ts',
      description: 'Add test',
      contentCharacters: 1,
    })
    expect(normalize(delta(2, '3D\\uDE00\\n\\"b"}'))).toMatchObject({ contentCharacters: 6 })
    const output = JSON.stringify(normalize(delta(3, ' ')))
    expect(output).not.toContain('argumentsDelta')
    expect(output).not.toContain('ignored')
  })

  it('redacts display descriptions, excludes file metadata on generic tools and seals ended blocks', () => {
    const normalize = createAlpha211SessionNormalizer()
    expect(
      normalize(
        delta(
          0,
          '{"description":"token=fixture-secret C:\\\\private\\\\a","file_path":"hidden","content":"body"}',
          { name: 'custom-tool' },
        ),
      ),
    ).toMatchObject({ description: 'token=[redacted] [path]' })
    expect(normalize(delta(1, ' '))).not.toHaveProperty('filePath')
    expect(normalize(delta(2, ' '))).not.toHaveProperty('contentCharacters')
    const ended = delta(3, '')
    normalize({
      ...ended,
      frame: {
        ...ended.frame,
        chunk: {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'call-1', name: 'custom-tool', arguments: '{}' },
        },
      },
    })
    expect(normalize(delta(4, 'straggler'))).toBeUndefined()
    const interrupted = createAlpha211SessionNormalizer()
    interrupted(delta(0, '{"content":"partial', { name: 'write' }))
    interrupted({
      type: 'session/assistant-interrupted',
      sessionId: 's1',
      attemptId: 'attempt-1',
      turn: 1,
      step: 1,
    })
    expect(interrupted(delta(1, 'late"}'))).toBeUndefined()
  })

  it.each([
    '{"description":"ok",}',
    '{"description":"ok","description":"override"}',
    '{"description":"ok","nested":[1}}',
    '{"description":"ok","nested":{"x":}}',
    '{"description":"ok","content":"bad\\q"}',
    '{"description":"ok","content":"bad\\uXXXX"}',
    '{"description":"ok","content":"bad\n"}',
    '{"description":"ok"}trailer',
  ])('clears a preview on invalid JSON syntax: %s', (text) => {
    const preview = new ArgumentPreview()
    for (const character of text) preview.append(character)
    expect(preview.snapshot()).toEqual({})
  })

  it('bounds retained text, keys, nested containers and active calls while streaming a large body', () => {
    const preview = new ArgumentPreview()
    preview.append(
      '{"description":"' + 'd'.repeat(1024) + '","file_path":"' + 'p'.repeat(4097) + '","content":"',
    )
    const chunk = 'x'.repeat(10_000)
    for (let index = 0; index < 100; index++) preview.append(chunk)
    expect(preview.snapshot()).toEqual({ description: 'd'.repeat(512), contentCharacters: 1_000_000 })
    // No content buffer survives a delta; retained memory depends on field/depth bounds.
    expect(JSON.stringify(preview).length).toBeLessThan(5_000)
    preview.append('"}')
    const tooDeep = new ArgumentPreview()
    tooDeep.append('{"description":"ok","x":' + '['.repeat(64))
    expect(tooDeep.snapshot()).toEqual({})
    const tooManyKeys = new ArgumentPreview()
    tooManyKeys.append(
      JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, 0]))),
    )
    expect(tooManyKeys.snapshot()).toEqual({})
    const normalize = createAlpha211SessionNormalizer()
    for (let index = 0; index < 128; index++)
      expect(normalize(delta(index, '{}', { id: `call-${index}`, name: 'read' }))).toHaveProperty(
        'type',
        'tool.preparing',
      )
    expect(normalize(delta(128, '{}', { id: 'overflow', name: 'read' }))).toBeUndefined()
  })
})
