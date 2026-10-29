import assert from 'node:assert/strict'
import { additionalScenarios } from './ui-additional-scenarios.mjs'

const prompt = { role: 'textbox', key: 'composer.prompt' }
const button = (key) => ({ role: 'button', key })
const input = async (ui, value) => {
  await ui.click(prompt)
  await ui.type(value)
}
const clear = async (ui) => {
  await ui.click(prompt)
  await ui.key('a', 2)
  await ui.key('Backspace')
}

export const dailyScenarios = [
  ...additionalScenarios,
  {
    name: 'daily/compact-activity',
    coverage: ['READ-01'],
    async run(ui) {
      await ui.afterPaint()
      const before = await ui.call('activityMetrics')
      await ui.call('compactActivities')
      const all = await ui.call('label', 'timeline.activity.showAll')
      await ui.waitFor((s) => s.controls.some((c) => c.name === all), 'earlier activity collapsed')
      await ui.afterPaint()
      const folded = await ui.call('activityMetrics')
      assert.equal(folded.height, before.height, 'activity disclosure preserves the scroll viewport')
      assert.equal(folded.top, before.top, 'activity disclosure does not move the scroll viewport')
      await ui.capture('compact-folded')
      assert((await ui.snapshot()).timeline.includes('Answer owned by Alpha conversation'))
      await ui.click({ role: 'button', name: all })
      const recent = await ui.call('label', 'timeline.activity.showRecent')
      await ui.waitFor((s) => s.controls.some((c) => c.name === recent), 'all activity expanded')
      await ui.afterPaint()
      const expanded = await ui.call('activityMetrics')
      assert(expanded.rows > folded.rows, 'expansion reveals actual transcript rows')
      await ui.capture('compact-expanded')
      console.log(JSON.stringify({ case: 'compact-activity', layout: ui.layout, before, folded, expanded }))
      await ui.click({ role: 'button', name: recent })
      await ui.waitFor((s) => s.controls.some((c) => c.name === all), 'older activity collapsed again')
      await ui.afterPaint()
      assert.equal((await ui.call('activityMetrics')).rows, folded.rows)
    },
  },
  {
    name: 'daily/session-title-picker',
    coverage: ['SESSION-02'],
    async run(ui) {
      await input(ui, 'Alpha title picker draft')
      const label = await ui.call('label', 'sessions.title')
      const title = (name) => ({ role: 'button', name: `${label}: ${name} conversation` })
      await ui.click(title('Alpha'))
      await ui.waitFor(
        (s) => s.controls.some((c) => c.role === 'option' && c.name === 'Beta conversation'),
        'session dropdown',
      )
      await ui.key('ArrowDown')
      await ui.key('Enter')
      await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Beta conversation'),
        'keyboard session switch',
      )
      assert.equal((await ui.snapshot()).prompt, '')
      await ui.click(title('Beta'))
      await ui.click({ role: 'option', name: 'Alpha conversation' })
      await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Alpha conversation'),
        'return to original session',
      )
      assert.equal((await ui.snapshot()).prompt, 'Alpha title picker draft')
      for (const width of [1100, 420, 280]) {
        await ui.viewport(width, 850)
        await ui.click(title('Alpha'))
        await ui.waitFor(
          (s) => s.controls.filter((c) => c.role === 'option').length === 3,
          'all available sessions',
        )
        await ui.afterPaint()
        await ui.capture(`session-title-${width}`)
        await ui.key('Escape')
        await ui.waitFor((s) => !s.controls.some((c) => c.role === 'option'), 'dropdown dismissal')
      }
    },
  },
  {
    name: 'daily/connection-retry',
    coverage: ['BOOT-04'],
    async run(ui) {
      await input(ui, 'Draft remains through reconnect')
      await ui.call('disconnect')
      const failed = await ui.call('label', 'runtime.status.connection-failed')
      await ui.waitFor((s) => s.controls.some((c) => c.name === failed), 'connection failure shown')
      await ui.click(button('runtime.status.connection-failed'))
      await ui.click(button('runtime.retry'))
      const connected = await ui.call('label', 'runtime.status.connected')
      const state = await ui.waitFor(
        (s) => s.controls.some((c) => c.name === connected),
        'connection restored',
      )
      assert.equal(state.prompt, 'Draft remains through reconnect')
      assert(state.timeline?.includes('Answer owned by Alpha conversation'))
      assert.equal(state.receipts.length, 0)
    },
  },
  {
    name: 'daily/late-session-open',
    coverage: ['SESSION-10', 'RECOVER-01'],
    async run(ui) {
      await input(ui, 'Keep alpha draft during navigation')
      await ui.call('holdSession', 'daily-b')
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Beta conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      await ui.click({ role: 'button', name: 'Beta conversation', contains: true })
      await ui.waitFor((s) => s.pending.includes('session.open'), 'delayed session open')
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Gamma conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      await ui.click({ role: 'button', name: 'Gamma conversation', contains: true })
      await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Gamma conversation'),
        'newer session selection',
      )
      await ui.call('release')
      await ui.waitFor((s) => !s.pending.includes('session.open'), 'delayed response delivered')
      await ui.afterPaint()
      const final = await ui.snapshot()
      assert(final.timeline?.includes('Answer owned by Gamma conversation'))
      assert(!final.timeline?.includes('Answer owned by Beta conversation'))
      assert.equal(final.prompt, '')
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Alpha conversation')))
        await ui.click({ role: 'button', name: 'Gamma conversation', contains: true })
      await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      const alpha = await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Alpha conversation'),
        'original session',
      )
      assert.equal(alpha.prompt, 'Keep alpha draft during navigation')
    },
  },
  {
    name: 'daily/cancel-unconfirmed-send',
    coverage: ['INPUT-09'],
    async run(ui) {
      await ui.call('hold', 'session.sendPrompt')
      await input(ui, 'Preserve the unconfirmed prompt')
      await ui.key('Enter')
      const pending = await ui.waitFor((s) => s.pending.includes('session.sendPrompt'), 'pending send')
      const send = pending.requests.find((request) => request.type === 'session.sendPrompt')
      assert(send !== undefined)
      await ui.click(button('composer.cancelSend'))
      const state = await ui.waitFor(
        (s) =>
          s.requests.some(
            (request) =>
              request.type === 'feature.request.cancel' && request.payload.targetRequestId === send.requestId,
          ) && s.prompt === 'Preserve the unconfirmed prompt',
        'cancel delivered and draft retained',
      )
      assert.equal(state.receipts.length, 0)
      assert(!state.timeline.includes('Preserve the unconfirmed prompt'))
    },
  },
  {
    name: 'daily/send-attachment-retry',
    coverage: ['ATTACH-08'],
    async run(ui) {
      await input(ui, 'Send this attachment')
      await ui.click(button('composer.attach'))
      await ui.waitFor((s) => s.text.includes('fixture-note.txt'), 'selected file')
      await ui.call('failNext', 'session.sendPrompt')
      await ui.click(prompt)
      await ui.key('Enter')
      await ui.waitFor(
        (s) =>
          s.text.includes('Fixture delivery refused') &&
          s.text.includes('fixture-note.txt') &&
          s.prompt === 'Send this attachment',
        'failed send retains attachment and draft',
      )
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) => s.receipts.length === 1 && s.prompt === '' && s.timeline?.includes('Send this attachment'),
        'attachment send accepted',
      )
      assert.equal(state.receipts[0].sessionId, 'daily-a')
      assert.equal(state.receipts[0].attachments[0].name, 'fixture-note.txt')
    },
  },
  {
    name: 'daily/remove-attachment',
    coverage: ['ATTACH-01'],
    async run(ui) {
      await input(ui, 'Draft survives attachment removal')
      await ui.click(button('composer.attach'))
      await ui.waitFor((s) => s.text.includes('fixture-note.txt'), 'attachment selected')
      await ui.click({ role: 'button', key: 'composer.remove', params: { name: 'fixture-note.txt' } })
      const state = await ui.waitFor(
        (s) =>
          !s.text.includes('fixture-note.txt') &&
          s.requests.some((request) => request.type === 'attachment.release'),
        'attachment removed and released',
      )
      assert.equal(state.prompt, 'Draft survives attachment removal')
    },
  },
  {
    name: 'daily/attachment-late-session-switch',
    coverage: ['ATTACH-06'],
    async run(ui) {
      await input(ui, 'Waiting for a file')
      await ui.call('hold', 'attachment.pick')
      await ui.click(button('composer.attach'))
      await ui.waitFor((s) => s.pending.includes('attachment.pick'), 'pending picker')
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Beta conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      await ui.click({ role: 'button', name: 'Beta conversation', contains: true })
      await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Beta conversation'),
        'second conversation',
      )
      await ui.call('release')
      const state = await ui.waitFor(
        (s) => s.requests.some((request) => request.type === 'attachment.release'),
        'stale attachment released',
      )
      assert(!state.text.includes('fixture-note.txt'))
      assert(state.timeline.includes('Beta conversation'))
    },
  },
  {
    name: 'daily/search-unavailable-and-clear',
    coverage: ['SESSION-04'],
    async run(ui) {
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Beta conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      await ui.call('failNext', 'session.list')
      const search = { role: 'textbox', key: 'sessions.searchAria' }
      await ui.click(search)
      await ui.type('Beta')
      const notice = await ui.call('label', 'sessions.searchUnavailable')
      const failed = await ui.waitFor(
        (s) => s.text.includes(notice) && s.controls.some((c) => c.name.includes('Beta conversation')),
        'content search unavailable with title result',
      )
      assert(
        failed.requests.some(
          (request) => request.type === 'session.list' && request.payload.search === 'Beta',
        ),
      )
      await ui.key('a', 2)
      await ui.key('Backspace')
      await ui.waitFor(
        (s) =>
          !s.text.includes(notice) &&
          s.controls.some((c) => c.name.includes('Alpha conversation')) &&
          s.controls.some((c) => c.name.includes('Beta conversation')),
        'full list restored',
      )
    },
  },
  {
    name: 'daily/rename-session-retry',
    coverage: ['SESSION-05'],
    async run(ui) {
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Beta conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      await ui.click({ role: 'button', key: 'sessions.actions', params: { title: 'Beta conversation' } })
      await ui.click(button('sessions.renameTitle'))
      const field = { role: 'textbox', key: 'sessions.sessionName' }
      await ui.click(field)
      await ui.key('a', 2)
      await ui.type('Renamed conversation')
      await ui.call('failNext', 'session.rename')
      await ui.click(button('common.save'))
      const save = await ui.call('label', 'common.save')
      await ui.waitFor(
        (s) =>
          s.text.includes('Fixture delivery refused') &&
          s.controls.some((control) => control.name === save && !control.disabled),
        'rename failure',
      )
      await ui.click(button('common.save'))
      const state = await ui.waitFor(
        (s) =>
          s.controls.some((control) => control.name.includes('Renamed conversation')) &&
          !s.controls.some((control) => control.name === save) &&
          s.requests.filter((request) => request.type === 'session.rename').length === 2,
        'rename succeeds after retry',
      )
      assert(
        state.requests
          .filter((request) => request.type === 'session.rename')
          .every((request) => request.payload.sessionId === 'daily-b'),
      )
      await ui.click({ role: 'button', name: 'Renamed conversation', contains: true })
      await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Beta conversation'),
        'renamed session opens',
      )
    },
  },
  {
    name: 'daily/search-sessions',
    coverage: ['WS-01', 'SESSION-03', 'SESSION-04'],
    async run(ui) {
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Beta conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      const search = { role: 'textbox', key: 'sessions.searchAria' }
      await ui.click(search)
      await ui.type('Beta')
      await ui.waitFor(
        (s) =>
          s.requests.some(
            (request) => request.type === 'session.list' && request.payload.search === 'Beta',
          ) && s.controls.some((c) => c.name.includes('Beta conversation')),
        'matching session',
      )
      await ui.click({ role: 'button', name: 'Beta conversation', contains: true })
      const state = await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Beta conversation'),
        'selected search result',
      )
      assert(!state.timeline.includes('Answer owned by Alpha conversation'))
    },
  },
  {
    name: 'daily/long-prompt',
    coverage: ['INPUT-05'],
    async run(ui) {
      const text = `Read the following content: ${'long-token-'.repeat(800)} End of prompt.`
      await input(ui, text)
      assert.equal((await ui.snapshot()).prompt, text)
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) => s.receipts.some((item) => item.text === text) && s.timeline?.includes(text),
        'complete long prompt',
      )
      assert.equal(state.receipts.filter((item) => item.text === text).length, 1)
      assert.equal(await ui.call('countText', text), 1)
    },
  },
  {
    name: 'daily/stop-retry',
    coverage: ['INPUT-10'],
    async run(ui) {
      await ui.call('status', 'running')
      await ui.call('failNext', 'session.cancel')
      const label = await ui.call('label', 'composer.stopResponse')
      await ui.waitFor(
        (s) => s.controls.some((control) => control.name === label && !control.disabled),
        'available Stop',
      )
      await ui.click(button('composer.stopResponse'))
      await ui.waitFor(
        (s) =>
          s.text.includes('Fixture delivery refused') &&
          s.controls.some((control) => control.name === label && !control.disabled),
        'failed Stop remains actionable',
      )
      await ui.click(button('composer.stopResponse'))
      const state = await ui.waitFor(
        (s) =>
          s.requests.filter((request) => request.type === 'session.cancel').length === 2 &&
          !s.controls.some((control) => control.name === label),
        'successful Stop retry',
      )
      assert(
        state.requests
          .filter((request) => request.type === 'session.cancel')
          .every((request) => request.payload.sessionId === 'daily-a'),
      )
    },
  },
  {
    name: 'daily/question-retry',
    coverage: ['INTERACT-07'],
    async run(ui) {
      await ui.call('failNext', 'interaction.question.respond')
      await ui.call('question')
      await ui.waitFor((s) => s.text.includes('First fixture option'), 'question')
      await ui.click({ role: 'radio', name: 'First fixture option' })
      await ui.click(button('question.submit'))
      const label = await ui.call('label', 'question.submit')
      await ui.waitFor(
        (s) =>
          s.text.includes('Fixture delivery refused') &&
          s.controls.some((control) => control.name === label && !control.disabled),
        'question remains retryable',
      )
      await ui.click(button('question.submit'))
      const state = await ui.waitFor(
        (s) => s.answers.length === 1 && !s.text.includes('First fixture option'),
        'question answer accepted',
      )
      assert(JSON.stringify(state.answers[0]).includes('first'))
    },
  },
  {
    name: 'daily/attachment-cancel',
    coverage: ['ATTACH-01'],
    async run(ui) {
      await input(ui, 'Draft retained after cancelling picker')
      await ui.call('cancelPicker')
      await ui.click(button('composer.attach'))
      const state = await ui.waitFor((s) => s.pickedAttachment, 'picker cancellation returned')
      assert.equal(state.prompt, 'Draft retained after cancelling picker')
      assert(!state.text.includes('fixture-note.txt'))
    },
  },
  {
    name: 'daily/disconnected-draft',
    coverage: ['BOOT-06'],
    async run(ui) {
      await input(ui, 'Draft during a connection loss')
      await ui.call('disconnect')
      const state = await ui.waitFor(
        (s) => s.prompt === 'Draft during a connection loss' && s.text.includes('Fixture connection lost'),
        'connection loss with retained draft',
      )
      assert.equal(state.receipts.length, 0)
    },
  },
  {
    name: 'daily/attachment-pick',
    coverage: ['ATTACH-01'],
    async run(ui) {
      await input(ui, 'Draft with a file')
      await ui.click(button('composer.attach'))
      const state = await ui.waitFor(
        (s) => s.pickedAttachment && s.text.includes('fixture-note.txt'),
        'selected attachment',
      )
      assert.equal(state.prompt, 'Draft with a file')
    },
  },
  {
    name: 'daily/queued-followup',
    coverage: ['QUEUE-01'],
    async run(ui) {
      await ui.call('status', 'running')
      await input(ui, 'A queued follow-up')
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) =>
          s.receipts.some((item) => item.text === 'A queued follow-up') &&
          s.fields.some((field) => field.value === 'A queued follow-up'),
        'queued follow-up',
      )
      assert.equal(state.receipts.filter((item) => item.text === 'A queued follow-up').length, 1)
      assert(!state.timeline.includes('A queued follow-up'))
    },
  },
  {
    name: 'daily/approval-retry',
    coverage: ['INTERACT-02'],
    async run(ui) {
      await ui.call('failNext', 'interaction.permission.respond')
      await ui.call('permission')
      await ui.waitFor((s) => s.text.includes('Deny fixture'), 'approval choices')
      await ui.click({ role: 'button', name: 'Deny fixture' })
      await ui.waitFor(
        (s) =>
          s.text.includes('Fixture delivery refused') &&
          s.controls.some((control) => control.name === 'Deny fixture' && !control.disabled),
        'retryable refusal',
      )
      await ui.click({ role: 'button', name: 'Deny fixture' })
      const state = await ui.waitFor(
        (s) => s.decisions.length === 1 && !s.text.includes('Deny fixture'),
        'refusal delivered on retry',
      )
      assert.equal(state.decisions[0].optionId, 'deny')
    },
  },
  {
    name: 'daily/question-multiple',
    coverage: ['INTERACT-05'],
    async run(ui) {
      await ui.call('question', true)
      await ui.waitFor((s) => s.text.includes('First fixture option'), 'multiple-choice question')
      await ui.click({ role: 'checkbox', name: 'First fixture option' })
      await ui.click({ role: 'checkbox', name: 'Second fixture option' })
      await ui.click(button('question.submit'))
      const state = await ui.waitFor(
        (s) => s.answers.length === 1 && !s.text.includes('First fixture option'),
        'multiple-choice answer',
      )
      const delivered = JSON.stringify(state.answers[0])
      assert(delivered.includes('first') && delivered.includes('second'))
    },
  },
  {
    name: 'daily/session-drafts',
    coverage: ['SESSION-02'],
    async run(ui) {
      await input(ui, 'Alpha private draft')
      if (!(await ui.snapshot()).controls.some((c) => c.name.includes('Beta conversation')))
        await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      await ui.click({ role: 'button', name: 'Beta conversation', contains: true })
      await ui.waitFor((s) => s.timeline?.includes('Answer owned by Beta conversation'), 'second session')
      assert.equal((await ui.snapshot()).prompt, '')
      await input(ui, 'Beta private draft')
      if (
        !(await ui.snapshot()).controls.some(
          (c) => c.name.includes('Alpha conversation') && !c.name.includes('Beta'),
        )
      )
        await ui.click({ role: 'button', name: 'Beta conversation', contains: true })
      await ui.click({ role: 'button', name: 'Alpha conversation', contains: true })
      const state = await ui.waitFor(
        (s) => s.timeline?.includes('Answer owned by Alpha conversation'),
        'original session',
      )
      assert.equal(state.prompt, 'Alpha private draft')
      assert(!state.timeline.includes('Beta conversation'))
    },
  },
  {
    name: 'daily/settings-focus',
    coverage: ['NAV-01', 'NAV-02'],
    async run(ui) {
      await input(ui, 'Settings should preserve this draft')
      await ui.click(button('settings.title'))
      const close = await ui.call('label', 'settings.close')
      await ui.waitFor((s) => s.controls.some((c) => c.name === close), 'settings drawer')
      await ui.key('Escape')
      const state = await ui.waitFor((s) => !s.controls.some((c) => c.name === close), 'settings dismissed')
      assert.equal(state.prompt, 'Settings should preserve this draft')
      assert.equal(state.focus, await ui.call('label', 'settings.title'))
    },
  },
  {
    name: 'daily/send',
    coverage: ['INPUT-01'],
    async run(ui) {
      const text = 'Daily prompt reaches its conversation'
      await input(ui, text)
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) =>
          s.receipts.some((receipt) => receipt.text === text) &&
          s.timeline?.includes(text) &&
          s.prompt === '',
        'accepted prompt and cleared draft',
      )
      assert.equal(state.receipts.filter((receipt) => receipt.text === text).length, 1)
      assert.equal(await ui.call('countText', text), 1)
    },
  },
  {
    name: 'daily/multiline-and-empty',
    coverage: ['INPUT-02', 'INPUT-04'],
    async run(ui) {
      await ui.click(prompt)
      await ui.key('Enter')
      assert.equal((await ui.snapshot()).receipts.length, 0)
      await ui.type('first line')
      await ui.key('Enter', 8)
      await ui.type('second line')
      const state = await ui.snapshot()
      assert.equal(state.prompt, 'first line\nsecond line')
      assert.equal(state.receipts.length, 0)
      await ui.key('Enter')
      await ui.waitFor(
        (s) => s.receipts.some((item) => item.text === 'first line\nsecond line'),
        'multiline submission',
      )
    },
  },
  {
    name: 'daily/send-retry',
    coverage: ['INPUT-08'],
    async run(ui) {
      await ui.call('failNext', 'session.sendPrompt')
      await input(ui, 'Preserve this failed draft')
      await ui.key('Enter')
      await ui.waitFor(
        (s) => s.prompt === 'Preserve this failed draft' && s.text.includes('Fixture delivery refused'),
        'visible failed delivery and retained draft',
      )
      await ui.key('Enter')
      await ui.waitFor(
        (s) => s.receipts.some((item) => item.text === 'Preserve this failed draft') && s.prompt === '',
        'retry succeeds',
      )
    },
  },
  {
    name: 'daily/inflight-new-draft',
    coverage: ['INPUT-06', 'INPUT-07'],
    async run(ui) {
      await ui.call('hold', 'session.sendPrompt')
      await input(ui, 'First admitted prompt')
      await ui.key('Enter')
      await ui.waitFor((s) => s.pending.includes('session.sendPrompt'), 'in-flight send')
      await ui.key('Enter')
      await clear(ui)
      await ui.type('New draft after sending')
      await ui.call('release')
      const state = await ui.waitFor(
        (s) => s.receipts.length === 1 && s.prompt === 'New draft after sending',
        'new draft survives receipt',
      )
      assert.equal(state.receipts[0].text, 'First admitted prompt')
    },
  },
  {
    name: 'daily/stop',
    coverage: ['INPUT-10'],
    async run(ui) {
      await ui.call('status', 'running')
      const label = await ui.call('label', 'composer.stopResponse')
      await ui.waitFor((s) => s.controls.some((c) => c.name === label && !c.disabled), 'Stop control')
      await ui.click(button('composer.stopResponse'))
      await ui.waitFor(
        (s) =>
          s.requests.some(
            (request) => request.type === 'session.cancel' && request.payload.sessionId === 'daily-a',
          ),
        'Stop delivered to current session',
      )
    },
  },
  {
    name: 'daily/approval',
    coverage: ['INTERACT-01', 'INPUT-11'],
    async run(ui) {
      await input(ui, 'Draft while awaiting approval')
      await ui.call('permission')
      await ui.waitFor((s) => s.text.includes('Allow fixture'), 'approval options')
      await ui.click({ role: 'button', name: 'Allow fixture' })
      const state = await ui.waitFor(
        (s) => s.decisions.length === 1 && !s.text.includes('Allow fixture'),
        'approval settled',
      )
      assert.equal(state.prompt, 'Draft while awaiting approval')
      assert.equal(state.decisions[0].optionId, 'allow')
    },
  },
  {
    name: 'daily/question',
    coverage: ['INTERACT-04', 'INPUT-11'],
    async run(ui) {
      await input(ui, 'Draft while answering')
      await ui.call('question')
      await ui.waitFor((s) => s.text.includes('First fixture option'), 'question options')
      await ui.click({ role: 'radio', name: 'First fixture option' })
      await ui.click(button('question.submit'))
      const state = await ui.waitFor(
        (s) => s.answers.length === 1 && !s.text.includes('First fixture option'),
        'question settled',
      )
      assert.equal(state.prompt, 'Draft while answering')
      assert(JSON.stringify(state.answers[0]).includes('first'))
    },
  },
]
