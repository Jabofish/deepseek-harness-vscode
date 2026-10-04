import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { AlphaEventSource } from '../src/versions/alpha/events.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { ArgumentPreview } from '../src/versions/alpha211/argument-preview.js'
import { createAlpha211SessionNormalizer } from '../src/versions/alpha211/tool-preparation.js'
import { normalizeEnvelope } from '../src/stream-envelopes.js'

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
  it('normalizes once per session for observers and listeners, replays reconnects and releases aborted streams', async () => {
    let released = 0
    const hold = async function* (signal: AbortSignal): AsyncGenerator<unknown, void> {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield* []
    }
    const transport = {
      request: () => Promise.reject(new Error('unused RPC')),
      openEventStream: hold,
      openWorkspaceStream: hold,
      async *openSessionStream(sessionId: string, signal: AbortSignal) {
        try {
          yield { payload: { type: 'session/subscribed', sessionId, lastSeq: 2, controlBaseline: false } }
          const frame = delta(0, '{"content":"abc"}', { name: 'write' })
          yield { payload: { ...frame, sessionId } }
          yield* hold(signal)
        } finally {
          released += 1
        }
      },
      close: vi.fn(() => Promise.resolve()),
    }
    const observed: BackendEvent[] = []
    const received: BackendEvent[] = []
    const source = new AlphaEventSource(
      transport as unknown as AlphaLoopbackApiClient & DshTransport,
      (event) => observed.push(event),
      undefined,
      undefined,
      (event) => event,
      createAlpha211SessionNormalizer,
    )
    const unsubscribe = source.subscribe((event) => received.push(event))
    source.watchSession('s1')
    source.watchSession('s2')
    try {
      await vi.waitFor(() =>
        expect(received.filter((event) => event.type === 'tool.preparing')).toHaveLength(2),
      )
      expect(observed.filter((event) => event.type === 'tool.preparing')).toEqual(
        received.filter((event) => event.type === 'tool.preparing'),
      )
      await source.refreshSession('s1')
      await vi.waitFor(() =>
        expect(received.filter((event) => event.type === 'tool.preparing')).toHaveLength(3),
      )
      expect(
        received
          .filter((event) => event.type === 'tool.preparing')
          .every((event) => event.contentCharacters === 3),
      ).toBe(true)
    } finally {
      unsubscribe()
      await source.close()
    }
    expect(released).toBe(3)
    expect(transport.close).not.toHaveBeenCalled()
  })

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

  it('isolates interleaved calls, duplicate frames, identities and attempts; restores a fresh reconnect baseline', () => {
    const normalize = createAlpha211SessionNormalizer()
    normalize(delta(0, '{"content":"one', { name: 'write' }))
    normalize(delta(1, '{"description":"two', { id: 'call-2', name: 'custom-tool' }))
    expect(normalize(delta(2, ' more"}'))).toMatchObject({ contentCharacters: 8 })
    expect(normalize(delta(2, 'duplicate'))).toBeUndefined()
    expect(normalize(delta(3, 'bad', { name: 'read' }))).toBeUndefined()
    expect(normalize(delta(4, ' done"}', { id: 'call-2' }))).toMatchObject({ description: 'two done' })
    expect(normalize(delta(0, '{"content":"new"}', { attemptId: 'attempt-2', name: 'write' }))).toMatchObject(
      { contentCharacters: 3 },
    )
    normalize({ type: 'session/subscribed', sessionId: 's1', lastSeq: 2 })
    expect(
      normalize(delta(0, '{"content":"replayed"}', { attemptId: 'attempt-2', name: 'write' })),
    ).toMatchObject({ contentCharacters: 8 })
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

  it('rejects malformed typed frames and leaves the legacy normalizer unchanged', () => {
    const frame = delta(0, '{}', { name: 'read' })
    for (const invalid of [
      { ...frame, sessionId: '' },
      { ...frame, frame: { ...frame.frame, type: 'end' } },
      { ...frame, frame: { ...frame.frame, index: -1 } },
      { ...frame, frame: { ...frame.frame, chunk: { ...frame.frame.chunk, argumentsDelta: 42 } } },
    ])
      expect(createAlpha211SessionNormalizer()(invalid)).toBeUndefined()
    expect(normalizeEnvelope(frame)).toBeUndefined()
  })
})
