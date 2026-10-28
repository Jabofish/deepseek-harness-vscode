import assert from 'node:assert/strict'

// Scenarios use public actions and visible reading contracts. Product DOM
// adapters and browser transport live elsewhere; no hook or virtualizer is mocked.
const navigation = ['resize', 'toggleLayout', 'resolveImage'].flatMap((change) =>
  ['jump', 'jump-reduced-motion', 'reveal', 'read'].map((intent) => ({
    name: `${change}/${intent}`,
    reader: true,
    contract: intent.startsWith('jump')
      ? 'latest'
      : intent === 'reveal'
        ? 'revealed'
        : change === 'resolveImage'
          ? 'reading'
          : 'source',
    observe: change === 'resolveImage' && intent === 'read',
    ready: change === 'resolveImage' ? (ui) => ui.act('addPendingImage') : undefined,
    async run(ui) {
      await ui.act(change)
      // Begin a second action during layout, before waiting for quiescence.
      await ui.afterPaint()
      if (intent === 'jump-reduced-motion') await ui.act('reduceMotion')
      if (intent.startsWith('jump')) await ui.act('jump')
      else if (intent === 'reveal') await ui.act('reveal')
    },
  })),
)

function readerAndFollower(name, run, prepare = () => undefined) {
  return [false, true].map((reader) => ({
    name: `${name}/${reader ? 'reading' : 'following'}`,
    reader,
    contract: reader ? 'reading' : 'latest',
    prepare,
    run,
    observe: true,
  }))
}

export const stabilityScenarios = [
  ...navigation,
  ...readerAndFollower(
    'stream-output',
    (ui) => ui.act('append'),
    (ui) => ui.act('startStream'),
  ),
  ...readerAndFollower('new-turn', (ui) => ui.act('newTurn')),
  ...readerAndFollower('composer-resize', (ui) => ui.act('composer')),
  ...readerAndFollower(
    'hidden-stream',
    async (ui) => {
      await ui.act('hide')
      await ui.afterPaint()
      await ui.act('append')
      await ui.afterPaint()
      await ui.act('show')
    },
    (ui) => ui.act('startStream'),
  ),
  ...readerAndFollower(
    'tool-completion',
    (ui) => ui.act('finish'),
    async (ui) => {
      await ui.act('prepareTool', 'code')
      await ui.act('startStream')
    },
  ),
  {
    name: 'keyboard-reading/panel-resize',
    reader: 'keyboard',
    contract: 'source',
    run: (ui) => ui.act('resize'),
  },
  {
    name: 'earlier-content-growth/reading',
    reader: true,
    contract: 'reading',
    observe: true,
    run: (ui) => ui.act('growEarlier'),
  },
  {
    name: 'history-prepend/reading',
    reader: true,
    contract: 'reading',
    observe: true,
    async run(ui) {
      await ui.act('requestHistory')
      await ui.act('completeHistory')
    },
  },
  {
    name: 'history-prepend/streaming',
    reader: true,
    contract: 'reading',
    observe: true,
    prepare: (ui) => ui.act('startStream'),
    async run(ui) {
      await ui.act('requestHistory')
      await ui.act('append')
      await ui.act('completeHistory')
    },
  },
  {
    name: 'history-prepend/new-reader-intent',
    reader: true,
    contract: 'reading',
    async run(ui) {
      await ui.act('requestHistory')
      await ui.wheel(0.25)
      await ui.settle()
      const expected = await ui.snapshot()
      await ui.act('observe')
      await ui.act('completeHistory')
      return expected
    },
    observe: true,
  },
  {
    name: 'smooth-jump/stream-output',
    reader: true,
    contract: 'latest',
    prepare: (ui) => ui.act('startStream'),
    async run(ui) {
      await ui.act('jump')
      await ui.afterPaint()
      await ui.act('append')
    },
  },
  ...['reader-input', 'smooth-jump'].map((outgoing) => ({
    name: `session-switch/${outgoing}`,
    reader: true,
    contract: 'latest',
    async run(ui) {
      if (outgoing === 'smooth-jump') await ui.act('jump')
      else await ui.wheel(0.25)
      await ui.act('reset', ui.turns, ui.layout)
    },
  })),
  ...['wheel', 'keyboard'].map((input) => ({
    name: `nested-details/${input}`,
    contract: 'latest',
    observe: true,
    async prepare(ui) {
      await ui.act('prepareTool', 'terminal')
      await ui.act('expandTool')
      await ui.act('startStream')
    },
    async run(ui) {
      const gesture = await ui.act('prepareInnerReading')
      const before = await ui.act('innerPosition')
      if (input === 'wheel') await ui.wheelAt(gesture)
      else await ui.key('PageUp')
      await ui.settle()
      assert.notEqual(await ui.act('innerPosition'), before, 'The nested input did not move its own content')
      await ui.act('append')
    },
  })),
  ...['code', 'table'].map((kind) => ({
    name: `stream-completion/${kind}`,
    contract: 'latest',
    observe: true,
    prepare: (ui) => ui.act('prepareRichText', kind),
    run: (ui) => ui.act('finish'),
  })),
  {
    name: 'late-image/following',
    contract: 'latest',
    observe: true,
    ready: (ui) => ui.act('addPendingImage'),
    run: (ui) => ui.act('resolveImage'),
  },
  ...['expand', 'collapse'].map((action) => ({
    name: `code-disclosure/${action}`,
    contract: 'latest',
    observe: true,
    async prepare(ui) {
      await ui.act('prepareTool', 'code', action === 'collapse')
      if (action === 'collapse') await ui.act('expandTool')
    },
    run: (ui) => ui.act(action === 'expand' ? 'expandTool' : 'collapseTool'),
  })),
]

function latest(snapshot) {
  assert(snapshot.atLatest && snapshot.latestVisible, 'The latest answer is not visible at the tail')
}

function reading(expected, actual, preserveOffset) {
  const source = actual.sources.find((item) => item.text === expected.anchor)
  assert(source !== undefined, 'The message being read left the viewport')
  if (preserveOffset) {
    assert(expected.offset !== undefined, 'The reading anchor is unavailable')
    assert(
      Math.abs(source.offset - expected.offset) <= 2,
      `The reading position drifted by ${source.offset - expected.offset}px`,
    )
  }
}

export async function runStabilityScenario(ui, test) {
  await ui.act('reset', ui.turns, ui.layout)
  await test.prepare?.(ui)
  await ui.settle()
  latest(await ui.snapshot())
  if (test.reader) {
    if (test.reader === 'keyboard') {
      await ui.act('focusTimeline')
      await ui.key('PageUp')
    } else await ui.wheel()
    await ui.settle()
    assert(!(await ui.snapshot()).atLatest, 'The input did not leave the latest answer')
  }
  if (test.ready) {
    await test.ready(ui)
    await ui.settle()
  }
  let before = await ui.snapshot()
  if (test.observe) await ui.act('observe')
  before = (await test.run(ui)) ?? before
  await ui.settle()
  const after = await ui.snapshot()
  const samples = await ui.act('stopObservation')
  try {
    if (test.observe) assert(samples.length > 0, 'No rendered observations were captured')
    if (test.contract === 'latest') latest(after)
    else if (test.contract === 'revealed')
      assert(await ui.act('revealedAnswerVisible'), 'The requested answer is outside the viewport')
    else reading(before, after, test.contract === 'reading')
    // A stable final position alone can conceal a visible jump and return.
    // Ordinary reading must hold throughout the after-render observation.
    if (test.contract === 'reading')
      for (const sample of samples.filter((sample) => sample.visible)) reading(before, sample, true)
  } catch (cause) {
    throw Object.assign(new Error('Reading contract failed', { cause }), {
      observations: { before, after, samples },
      detail: String(cause),
    })
  }
  return { before, after, samples }
}

export async function shortConversationScenario(ui) {
  await ui.act('reset', 1, ui.layout, true)
  await ui.settle()
  const before = await ui.snapshot()
  assert(before.scrollHeight <= before.clientHeight, 'The short conversation already overflows')
  await ui.wheel()
  await ui.afterPaint()
  let publications = 0
  while ((await ui.snapshot()).scrollHeight <= before.clientHeight && publications < 10) {
    await ui.act('append')
    await ui.afterPaint()
    publications += 1
  }
  await ui.settle()
  const after = await ui.snapshot()
  assert(after.scrollHeight > after.clientHeight, 'Incoming output did not make the conversation scrollable')
  latest(after)
  return { before, after }
}
