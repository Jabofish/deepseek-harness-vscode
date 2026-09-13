import type { HostMessage } from '@dsh-vscode/webview-protocol'

/**
 * A desensitized replay of a long real DSH conversation.
 *
 * The event order, per-turn step counts, tool vocabulary and payload shapes are
 * taken from a real 18-turn / 47-step session captured from DSH 0.1.5: durable
 * `turn/step/tool` rows, process-local assistant frames (cursorless deltas),
 * `assistant/message` completions, `todo/write`, subagent inbox reports and
 * `deliverables/presented`. Every path, command, identifier and sentence below
 * is synthetic: nothing here comes from the original session, and the
 * repository is fictional.
 *
 * The Host envelope sequence is generated and always unique, while the DSH
 * durable cursor travels in `payload.sequence` for durable rows only. The two
 * are deliberately independent: a control projection may describe the same
 * cursor as the durable row that follows it.
 */

export const LONG_SESSION_ID = 'session-long-desensitized'

interface Transient {
  readonly transientSequence: number
  readonly attemptId: string
  readonly index: number
  readonly startedAfter: number
}

function buildLongSession(): readonly HostMessage[] {
  let hostSequence = 0
  const emit = (name: string, payload: Readonly<Record<string, unknown>>): HostMessage => ({
    type: 'event',
    name,
    sequence: (hostSequence += 1),
    payload,
  })

  const user = (
    durable: number,
    messageId: string,
    markdown: string,
    source = 'user',
    sourceForm?: string,
  ): HostMessage =>
    emit('message.user', {
      sessionId: LONG_SESSION_ID,
      messageId,
      markdown,
      source,
      ...(sourceForm === undefined ? {} : { sourceForm }),
      rpcId: `rpc-${messageId}`,
      sequence: durable,
    })

  const turnStarted = (durable: number, turn: number): HostMessage =>
    emit('turn.started', { sessionId: LONG_SESSION_ID, turn, sequence: durable })

  const turnEnded = (durable: number, turn: number): HostMessage =>
    emit('turn.ended', { sessionId: LONG_SESSION_ID, turn, reason: 'completed', sequence: durable })

  const stepStarted = (durable: number, turn: number, step: number, time: number): HostMessage =>
    emit('step.started', { sessionId: LONG_SESSION_ID, turn, step, time, sequence: durable })

  const stepEnded = (durable: number, turn: number, step: number, time: number): HostMessage =>
    emit('step.ended', { sessionId: LONG_SESSION_ID, turn, step, time, sequence: durable })

  const reasoning = (
    durable: number,
    messageId: string,
    turn: number,
    step: number,
    text: string,
    transient: Transient,
  ): HostMessage =>
    emit('reasoning.delta', {
      sessionId: LONG_SESSION_ID,
      messageId,
      delta: text,
      turn,
      step,
      transientSequence: transient.transientSequence,
      transientAttemptId: transient.attemptId,
      transientIndex: transient.index,
      transientStartedAfterSequence: transient.startedAfter,
    })

  const delta = (
    durable: number,
    messageId: string,
    turn: number,
    step: number,
    text: string,
    transient: Transient,
  ): HostMessage =>
    emit('message.delta', {
      sessionId: LONG_SESSION_ID,
      messageId,
      delta: text,
      turn,
      step,
      transientSequence: transient.transientSequence,
      transientAttemptId: transient.attemptId,
      transientIndex: transient.index,
      transientStartedAfterSequence: transient.startedAfter,
    })

  const completed = (
    durable: number,
    messageId: string,
    turn: number,
    step: number,
    markdown: string,
    options: { readonly reasoning?: string; readonly time: number },
  ): HostMessage =>
    emit('message.completed', {
      sessionId: LONG_SESSION_ID,
      messageId,
      markdown,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      modelLabel: 'dsv4-flash',
      usage: { inputTokens: 6_400, outputTokens: 220, cacheReadTokens: 1_024, reasoningTokens: 90 },
      turn,
      step,
      time: options.time,
      sequence: durable,
    })

  const toolCall = (
    durable: number,
    id: string,
    turn: number,
    step: number,
    name: string,
    input: Readonly<Record<string, unknown>>,
    time: number,
  ): HostMessage =>
    emit('tool.updated', {
      sessionId: LONG_SESSION_ID,
      tool: {
        id,
        turn,
        step,
        name,
        category: 'tool',
        title: name,
        status: 'running',
        startedAt: new Date(time).toISOString(),
        inputSummary: JSON.stringify(input),
        metadata: {},
      },
      sequence: durable,
    })

  /**
   * Real DSH tool results do not repeat the tool identity: the mapped row
   * reports `unknown-tool` and the timeline merges it into the call row by call
   * id, which is why the merged card still shows the real tool name.
   */
  const toolResult = (
    durable: number,
    id: string,
    turn: number,
    step: number,
    outputSummary: string,
    options: { readonly error?: string; readonly time: number },
  ): HostMessage =>
    emit('tool.updated', {
      sessionId: LONG_SESSION_ID,
      tool: {
        id,
        turn,
        step,
        name: 'unknown-tool',
        category: 'tool',
        title: 'Tool',
        status: options.error === undefined ? 'completed' : 'failed',
        completedAt: new Date(options.time).toISOString(),
        ...(options.error === undefined ? {} : { error: options.error }),
        outputSummary,
        metadata: {},
      },
      sequence: durable,
    })

  const readmeHead = [
    '<path>demo-notes/README.md</path>',
    '<type>file</type>',
    '<content>',
    '1: # demo-notes',
    '2: ',
    '3: 一个本地优先的笔记同步工具。',
    '4: ',
    '5: ## 快速开始',
    '6: ',
    '7: ```bash',
    '8: pnpm install',
    '9: pnpm demo',
    '10: ```',
    '',
    '(End of file - total 10 lines)',
    '</content>',
  ].join('\n')

  return [
    // Turn 1 — plain question, answered without tools.
    user(101, 'user-1', '这个仓库是做什么的？'),
    turnStarted(102, 1),
    stepStarted(103, 1, 1, 1_786_500_000_001),
    reasoning(104, 'assistant:1:1', 1, 1, '用户想先了解项目用途，读一眼仓库概览再回答。', {
      transientSequence: 101,
      attemptId: `${LONG_SESSION_ID}:1`,
      index: 1,
      startedAfter: 103,
    }),
    completed(
      105,
      'aaaaaaaa-1111-4111-8111-000000000001',
      1,
      1,
      [
        '这是一个**本地优先的笔记同步**工具，主要分三块：',
        '',
        '- `src/`：同步核心与命令行入口',
        '- `docs/`：设计与使用说明',
        '- `tests/`：端到端回归',
        '',
        '配置写在 `notes.config.json`，默认目录是 `notes/`。',
      ].join('\n'),
      { reasoning: '用途问题，直接回答即可，不需要调用工具。', time: 1_786_500_000_100 },
    ),
    stepEnded(106, 1, 1, 1_786_500_000_120),
    turnEnded(107, 1),

    // Turn 2 — glob then read, then a tabular answer.
    user(110, 'user-2', '先看看项目里有哪些文件，再读一下 README.md 的开头。'),
    turnStarted(111, 2),
    stepStarted(112, 2, 1, 1_786_500_010_001),
    toolCall(113, 'call_glob_0001', 2, 1, 'glob', { pattern: '**/*' }, 1_786_500_010_010),
    toolResult(
      114,
      'call_glob_0001',
      2,
      1,
      [
        'docs/design.md',
        'notes/ideas.md',
        'src/cli.ts',
        'src/store.ts',
        'src/sync.ts',
        'tests/sync.spec.ts',
        'README.md',
        'notes.config.json',
      ].join('\n'),
      { time: 1_786_500_010_020 },
    ),
    stepEnded(115, 2, 1, 1_786_500_010_030),
    stepStarted(116, 2, 2, 1_786_500_011_001),
    toolCall(
      117,
      'call_read_0002',
      2,
      2,
      'read',
      { file_path: 'demo-notes/README.md', offset: 1, limit: 10 },
      1_786_500_011_010,
    ),
    toolResult(118, 'call_read_0002', 2, 2, readmeHead, { time: 1_786_500_011_020 }),
    stepEnded(119, 2, 2, 1_786_500_011_030),
    stepStarted(120, 2, 3, 1_786_500_012_001),
    completed(
      121,
      'aaaaaaaa-2222-4222-8222-000000000002',
      2,
      3,
      [
        '仓库里有 8 个文件，主要目录已经清楚了：',
        '',
        '| 目录 | 内容 |',
        '| --- | --- |',
        '| `src/` | `cli.ts`、`store.ts`、`sync.ts` |',
        '| `tests/` | `sync.spec.ts` |',
        '| `docs/` | 设计说明 |',
        '',
        'README 开头写明这是一个**本地优先**的笔记同步工具，快速开始只需要 `pnpm install` 和 `pnpm demo` 两条命令。',
      ].join('\n'),
      { time: 1_786_500_012_100 },
    ),
    stepEnded(122, 2, 3, 1_786_500_012_120),
    turnEnded(123, 2),

    // Turn 3 — read, edit, then run the test suite.
    user(130, 'user-3', '在 README 的「快速开始」后面补一段说明，然后跑一下测试确认没坏。'),
    turnStarted(131, 3),
    stepStarted(132, 3, 1, 1_786_500_020_001),
    toolCall(133, 'call_read_0003', 3, 1, 'read', { file_path: 'demo-notes/README.md' }, 1_786_500_020_010),
    toolResult(134, 'call_read_0003', 3, 1, readmeHead, { time: 1_786_500_020_020 }),
    stepEnded(135, 3, 1, 1_786_500_020_030),
    stepStarted(136, 3, 2, 1_786_500_021_001),
    toolCall(
      137,
      'call_edit_0004',
      3,
      2,
      'edit',
      {
        file_path: 'demo-notes/README.md',
        old_string: 'pnpm demo\n```',
        new_string: 'pnpm demo\n```\n\n首次运行会在 `notes/` 下生成示例笔记，可以直接编辑。',
      },
      1_786_500_021_010,
    ),
    toolResult(
      138,
      'call_edit_0004',
      3,
      2,
      '<path>demo-notes/README.md</path>\n<type>file</type>\n<content>\nUpdated README.md\n</content>',
      { time: 1_786_500_021_020 },
    ),
    stepEnded(139, 3, 2, 1_786_500_021_030),
    stepStarted(140, 3, 3, 1_786_500_022_001),
    toolCall(
      141,
      'call_pwsh_0005',
      3,
      3,
      'pwsh',
      { command: 'pnpm test', description: '运行测试套件' },
      1_786_500_022_010,
    ),
    toolResult(
      142,
      'call_pwsh_0005',
      3,
      3,
      [
        '> demo-notes@0.3.0 test',
        '> vitest run',
        '',
        'Test Files  3 passed (3)',
        '     Tests  12 passed (12)',
        '  Duration  1.84s',
      ].join('\n'),
      { time: 1_786_500_023_500 },
    ),
    stepEnded(143, 3, 3, 1_786_500_023_520),
    stepStarted(144, 3, 4, 1_786_500_024_001),
    completed(
      145,
      'aaaaaaaa-3333-4333-8333-000000000003',
      3,
      4,
      [
        'README 已经补上说明，测试全绿。',
        '',
        '| 检查项 | 结果 |',
        '| --- | --- |',
        '| 编辑 `README.md` | 已写入 |',
        '| `pnpm test` | 12 个用例全部通过 |',
      ].join('\n'),
      { reasoning: '编辑和测试都完成了，汇总一下结果。', time: 1_786_500_024_100 },
    ),
    stepEnded(146, 3, 4, 1_786_500_024_120),
    turnEnded(147, 3),

    // Turn 4 — grep succeeds, the follow-up edit fails and must stay visible.
    user(150, 'user-4', '搜一下 `src/` 里还有哪些 TODO，然后把「未启用」都改成「已启用」。'),
    turnStarted(151, 4),
    stepStarted(152, 4, 1, 1_786_500_030_001),
    toolCall(
      153,
      'call_grep_0006',
      4,
      1,
      'grep',
      { pattern: 'TODO', path: 'demo-notes/src' },
      1_786_500_030_010,
    ),
    toolResult(
      154,
      'call_grep_0006',
      4,
      1,
      [
        'demo-notes/src/store.ts:87:  // TODO: 处理冲突',
        'demo-notes/src/sync.ts:42:  // TODO: 支持增量同步',
      ].join('\n'),
      { time: 1_786_500_030_020 },
    ),
    stepEnded(155, 4, 1, 1_786_500_030_030),
    stepStarted(156, 4, 2, 1_786_500_031_001),
    toolCall(
      157,
      'call_edit_0007',
      4,
      2,
      'edit',
      { file_path: 'demo-notes/src/store.ts', old_string: '未启用', new_string: '已启用' },
      1_786_500_031_010,
    ),
    toolResult(
      158,
      'call_edit_0007',
      4,
      2,
      'Error: cannot modify "demo-notes/src/store.ts": the old string was not found',
      {
        error: 'Error: cannot modify "demo-notes/src/store.ts": the old string was not found',
        time: 1_786_500_031_020,
      },
    ),
    stepEnded(159, 4, 2, 1_786_500_031_030),
    stepStarted(160, 4, 3, 1_786_500_032_001),
    completed(
      161,
      'aaaaaaaa-4444-4444-8444-000000000004',
      4,
      3,
      [
        '`src/` 里还剩两处 TODO：`store.ts` 的冲突处理、`sync.ts` 的增量同步。',
        '',
        '另外那次编辑没有生效：文件里找不到「未启用」这个字符串，所以 `store.ts` 保持原样。',
      ].join('\n'),
      { time: 1_786_500_032_100 },
    ),
    stepEnded(162, 4, 3, 1_786_500_032_120),
    turnEnded(163, 4),

    // Turn 5 — web search. The control projection describes cursor 171, the
    // same cursor the durable completion then owns; it must never consume a
    // durable slot (the P0 regression this guards).
    user(170, 'user-5', '查一下 Node.js 24 现在是不是 LTS。'),
    turnStarted(171, 5),
    stepStarted(172, 5, 1, 1_786_500_040_001),
    toolCall(
      173,
      'call_search_0008',
      5,
      1,
      'web_search',
      { query: 'Node.js 24 LTS 状态' },
      1_786_500_040_010,
    ),
    toolResult(
      174,
      'call_search_0008',
      5,
      1,
      [
        'Node.js 24 已于 2025 年 10 月进入 Active LTS。',
        '',
        '来源：',
        '- nodejs.org/en/about/previous-releases',
      ].join('\n'),
      { time: 1_786_500_041_200 },
    ),
    stepEnded(175, 5, 1, 1_786_500_041_220),
    stepStarted(176, 5, 2, 1_786_500_042_001),
    emit('session.projection', {
      sessionId: LONG_SESSION_ID,
      key: 'next-turn',
      value: [{ turn: 6, seq: 177 }],
      sequence: 177,
    }),
    completed(
      177,
      'aaaaaaaa-5555-4555-8555-000000000005',
      5,
      2,
      [
        'Node.js 24 现在是 **Active LTS**（2025 年 10 月进入），维护期到 2028 年 4 月。',
        '',
        '如果只是本地跑脚本，用 24 的 LTS 版本就行。',
      ].join('\n'),
      { time: 1_786_500_042_100 },
    ),
    stepEnded(178, 5, 2, 1_786_500_042_120),
    turnEnded(179, 5),

    // Turn 6 — subagent, TODO list, inbox report, deliverables, then the final
    // streamed answer (cursorless frames followed by the durable completion).
    user(180, 'user-6', '帮我开个子代理调研一下打包方案，记进 TODO，最后汇总结论。'),
    turnStarted(181, 6),
    stepStarted(182, 6, 1, 1_786_500_050_001),
    toolCall(
      183,
      'call_subagent_0009',
      6,
      1,
      'subagent',
      { description: '调研打包方案', prompt: '比较 tsup 与 rollup 两种打包方式的取舍，给出一句结论。' },
      1_786_500_050_010,
    ),
    toolResult(184, 'call_subagent_0009', 6, 1, 'started subagent 0f3a1c2d-5b6e-4a7f-9c8d-1e2f3a4b5c6d', {
      time: 1_786_500_050_020,
    }),
    stepEnded(185, 6, 1, 1_786_500_050_030),
    stepStarted(186, 6, 2, 1_786_500_051_001),
    toolCall(
      187,
      'call_todo_0010',
      6,
      2,
      'todo_write',
      {
        todos: [
          { content: '调研打包方案（子代理进行中）', status: 'in_progress' },
          { content: '整理最终结论', status: 'pending' },
        ],
      },
      1_786_500_051_010,
    ),
    emit('todo.updated', {
      sessionId: LONG_SESSION_ID,
      todos: [
        { id: 'todo:0', content: '调研打包方案（子代理进行中）', status: 'in-progress' },
        { id: 'todo:1', content: '整理最终结论', status: 'pending' },
      ],
      sequence: 188,
    }),
    toolResult(189, 'call_todo_0010', 6, 2, 'Updated 2 todos', { time: 1_786_500_051_020 }),
    stepEnded(190, 6, 2, 1_786_500_051_030),
    user(
      191,
      'user-subagent-report',
      [
        'Background subagent 0f3a1c2d-5b6e-4a7f-9c8d-1e2f3a4b5c6d reported:',
        '',
        '打包方案调研完成：`tsup` 配置最少、适合当前体量；`rollup` 产物更可控但需要额外插件维护。建议先用 `tsup`。',
      ].join('\n'),
      'subagent-report',
      'relay',
    ),
    stepStarted(192, 6, 3, 1_786_500_052_001),
    toolCall(
      193,
      'call_read_0011',
      6,
      3,
      'read',
      { file_path: 'demo-notes/notes.config.json' },
      1_786_500_052_010,
    ),
    toolResult(
      194,
      'call_read_0011',
      6,
      3,
      '<path>demo-notes/notes.config.json</path>\n<type>file</type>\n<content>\n1: {\n2:   "notesDir": "notes",\n3:   "portable": true\n4: }\n\n(End of file - total 4 lines)\n</content>',
      { time: 1_786_500_052_020 },
    ),
    stepEnded(195, 6, 3, 1_786_500_052_030),
    stepStarted(196, 6, 4, 1_786_500_053_001),
    reasoning(197, 'assistant:6:4', 6, 4, '子代理的结论已经回来，结合刚才的配置确认一下打包目标。', {
      transientSequence: 401,
      attemptId: `${LONG_SESSION_ID}:6`,
      index: 1,
      startedAfter: 195,
    }),
    delta(198, 'assistant:6:4', 6, 4, '子代理调研完成，结论如下：', {
      transientSequence: 402,
      attemptId: `${LONG_SESSION_ID}:6`,
      index: 2,
      startedAfter: 195,
    }),
    delta(199, 'assistant:6:4', 6, 4, '建议先用 `tsup`，配置最少；`rollup` 留到需要精细控制产物时再引入。', {
      transientSequence: 403,
      attemptId: `${LONG_SESSION_ID}:6`,
      index: 3,
      startedAfter: 195,
    }),
    completed(
      200,
      'aaaaaaaa-6666-4666-8666-000000000006',
      6,
      4,
      [
        '子代理调研完成，结论如下：',
        '',
        '**建议先用 `tsup`**，配置最少；`rollup` 留到需要精细控制产物时再引入。',
        '',
        '- 打包目标：`src/cli.ts` → ESM',
        '- 配置文件保持 `notes.config.json` 不变',
        '',
        'TODO 里的两项已经同步更新。',
      ].join('\n'),
      { reasoning: '结论来自子代理，最后核对了一遍配置文件。', time: 1_786_500_053_100 },
    ),
    emit('deliverables.presented', {
      sessionId: LONG_SESSION_ID,
      turn: 6,
      callId: 'call_read_0011',
      files: [{ path: 'demo-notes/notes.config.json', description: '最终配置' }],
      sequence: 201,
    }),
    stepEnded(202, 6, 4, 1_786_500_053_120),
    turnEnded(203, 6),
  ]
}

export const longSessionMessages: readonly HostMessage[] = buildLongSession()
