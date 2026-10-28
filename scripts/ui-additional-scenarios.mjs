import assert from 'node:assert/strict'

const prompt = { role: 'textbox', key: 'composer.prompt' }
const button = (key, params) => ({ role: 'button', key, params })
const type = async (ui, text, field = prompt) => {
  await ui.click(field)
  await ui.type(text)
}
const replace = async (ui, text, field) => {
  await ui.click(field)
  await ui.key('a', 2)
  await ui.type(text)
}
const queued = async (ui, text = 'A prompt waiting for admission') => {
  await ui.call('status', 'running')
  await type(ui, text)
  await ui.key('Enter')
  return ui.waitFor(
    (s) => s.queue.some((item) => item.text === text) && s.fields.some((field) => field.value === text),
    'accepted queued prompt',
  )
}
const chooseModel = async (ui) => {
  await ui.click({ role: 'button', key: 'model.aria', contains: true })
  await ui.click({ role: 'menuitem', key: 'model.menuModel', contains: true })
  await ui.click({ role: 'button', name: 'Alternative model', contains: true })
}

export const additionalScenarios = [
  {
    name: 'daily/startup-restore',
    coverage: ['BOOT-01'],
    async run(ui) {
      const state = await ui.snapshot()
      assert(state.timeline.includes('Answer owned by Alpha conversation'))
      assert.equal(state.receipts.length, 0)
      await type(ui, 'Restored conversation is editable')
      assert.equal((await ui.snapshot()).prompt, 'Restored conversation is editable')
      assert.equal((await ui.snapshot()).receipts.length, 0)
    },
  },
  {
    name: 'daily/new-conversation',
    coverage: ['SESSION-01', 'CONFIG-07'],
    async run(ui) {
      await ui.click(button('sessions.new'))
      await ui.waitFor(
        (s) => s.prompt === '' && !s.timeline?.includes('Answer owned by Alpha'),
        'local new conversation',
      )
      assert.equal((await ui.snapshot()).requests.filter((r) => r.type === 'session.create').length, 0)
      await type(ui, 'The first prompt creates one conversation')
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) => s.receipts.length === 1 && s.timeline?.includes('The first prompt creates one conversation'),
        'first prompt admitted',
      )
      const creation = state.requests.filter((r) => r.type === 'session.create')
      assert.equal(creation.length, 1)
      assert.equal(state.receipts[0].sessionId, state.opened)
      assert.equal(creation[0].payload.configuration.preset, 'standard')
    },
  },
  {
    name: 'daily/export-nested-escape',
    coverage: ['NAV-03', 'NAV-08', 'FILES-07'],
    async run(ui) {
      await type(ui, 'Draft stays while export is cancelled')
      await ui.call('status', 'running')
      await ui.click(button('app.conversationActions'))
      await ui.click(button('export.trigger'))
      const title = await ui.call('label', 'export.title')
      await ui.waitFor((s) => s.dialogs.some((d) => d.name === title), 'export dialog')
      await ui.click({ ...button('export.format'), contains: true })
      await ui.key('Escape')
      assert(
        (await ui.snapshot()).dialogs.some((d) => d.name === title),
        'Escape dismisses the inner selector first',
      )
      await ui.key('Escape')
      const trigger = await ui.call('label', 'app.conversationActions')
      const state = await ui.waitFor(
        (s) => !s.dialogs.some((d) => d.name === title) && s.focus === trigger,
        'export dismissed and visible trigger focused',
      )
      assert.equal(state.prompt, 'Draft stays while export is cancelled')
      assert.equal(state.requests.filter((r) => r.type === 'session.export').length, 0)
    },
  },
  {
    name: 'daily/ime-confirmation',
    coverage: ['INPUT-03'],
    async run(ui) {
      await ui.click(prompt)
      await ui.compose('输入法确认')
      await ui.key('Enter')
      assert.equal((await ui.snapshot()).receipts.length, 0, 'Confirming composition cannot send')
      await ui.compose('')
      await ui.type('输入法确认')
      await ui.afterPaint()
      const draft = (await ui.snapshot()).prompt
      assert(draft.includes('输入法确认'))
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) => s.receipts.length === 1 && s.timeline.includes(draft),
        'explicit send after composition',
      )
      assert.equal(state.receipts[0].text, draft)
    },
  },
  {
    name: 'daily/model-selection',
    coverage: ['CONFIG-01'],
    async run(ui) {
      await type(ui, 'Keep draft while selecting a model')
      await chooseModel(ui)
      const state = await ui.waitFor(
        (s) => s.configuration.model.modelId === 'other-model',
        'model selection accepted',
      )
      assert.equal(state.prompt, 'Keep draft while selecting a model')
      assert(state.controls.some((control) => control.name.includes('Alternative model')))
      await ui.click(prompt)
      await ui.key('Enter')
      await ui.waitFor((s) => s.receipts.length === 1, 'send with selected route')
      const save = state.requests.find((request) => request.type === 'session.configure')
      assert.equal(save.payload.sessionId, 'daily-a')
      assert.equal(save.payload.configuration.model.modelId, 'other-model')
    },
  },
  {
    name: 'daily/model-selection-retry',
    coverage: ['CONFIG-08'],
    async run(ui) {
      await ui.call('failNext', 'session.configure')
      await type(ui, 'Draft survives model refusal')
      await chooseModel(ui)
      const message = await ui.call('label', 'model.applyFailed')
      const failed = await ui.waitFor((s) => s.text.includes(message), 'model error stays visible')
      assert.equal(failed.configuration.model.modelId, 'fixture-model')
      assert.equal(failed.prompt, 'Draft survives model refusal')
      await ui.click({ role: 'button', name: 'Alternative model', contains: true })
      await ui.waitFor(
        (s) => s.configuration.model.modelId === 'other-model' && !s.text.includes(message),
        'model retry accepted',
      )
    },
  },
  {
    name: 'daily/queue-edit',
    coverage: ['QUEUE-03'],
    async run(ui) {
      const initial = await queued(ui)
      const field = { role: 'textbox', key: 'queue.edit', params: { position: 1 } }
      const text = 'Revised queued prompt\nwith another line'
      await replace(ui, text, field)
      await ui.key('Enter', 2)
      const state = await ui.waitFor((s) => s.queue[0]?.text === text, 'queue edit accepted')
      assert.equal(state.queue[0].id, initial.queue[0].id)
      assert.equal(state.receipts.length, 1)
      assert(!state.timeline.includes(text))
    },
  },
  {
    name: 'daily/queue-edit-retry',
    coverage: ['QUEUE-05'],
    async run(ui) {
      const initial = await queued(ui)
      await ui.call('failNext', 'session.queue.update')
      const field = { role: 'textbox', key: 'queue.edit', params: { position: 1 } }
      await replace(ui, 'Rejected edit', field)
      await ui.key('Enter', 2)
      const failed = await ui.waitFor(
        (s) =>
          s.text.includes('Fixture delivery refused') &&
          s.fields.some((f) => f.value === initial.queue[0].text),
        'rejected edit restores authoritative text',
      )
      assert.equal(failed.queue[0].text, initial.queue[0].text)
      await replace(ui, 'Accepted edit after retry', field)
      await ui.key('Enter', 2)
      await ui.waitFor((s) => s.queue[0]?.text === 'Accepted edit after retry', 'queue retry accepted')
    },
  },
  {
    name: 'daily/queue-remove',
    coverage: ['QUEUE-04'],
    async run(ui) {
      await queued(ui, 'Remove this queued prompt')
      await queued(ui, 'Keep this queued prompt')
      await ui.click(button('queue.remove', { position: 1 }))
      const state = await ui.waitFor(
        (s) => s.queue.length === 1 && !s.fields.some((f) => f.value === 'Remove this queued prompt'),
        'only selected item removed',
      )
      assert.equal(state.queue[0].text, 'Keep this queued prompt')
      assert.equal(state.receipts.length, 2)
    },
  },
  {
    name: 'daily/queue-steer',
    coverage: ['QUEUE-02', 'QUEUE-04'],
    async run(ui) {
      const initial = await queued(ui)
      await ui.click({ ...button('queue.mode', { position: 1 }), contains: true })
      await ui.click({ role: 'button', key: 'queue.mode.steer' })
      const state = await ui.waitFor((s) => s.queue[0]?.mode === 'steer', 'queued item now steering')
      assert.equal(state.queue[0].id, initial.queue[0].id)
      assert.equal(state.queue.length, 1)
      assert.equal(state.receipts.length, 1)
    },
  },
  {
    name: 'daily/queue-admission',
    coverage: ['QUEUE-06'],
    async run(ui) {
      const text = 'A queued prompt becomes a durable turn'
      await queued(ui, text)
      await ui.call('admitQueue')
      const state = await ui.waitFor(
        (s) => s.timeline.includes(text) && !s.fields.some((f) => f.value === text),
        'queue transfers into transcript',
      )
      assert.equal(state.queue.length, 0)
      assert.equal(state.receipts.length, 1)
      assert.equal(await ui.call('countText', text), 1)
    },
  },
  {
    name: 'daily/settings-tab-trap',
    coverage: ['NAV-04', 'AX-05'],
    async run(ui) {
      await type(ui, 'Retain draft through modal keyboard navigation')
      await ui.click(button('settings.title'))
      const state = await ui.waitFor((s) => s.dialogs.length > 0, 'settings modal')
      // Walk every available control in both directions; the fixture measures
      // the current surface rather than assuming its number or DOM order.
      for (const modifiers of [0, 8])
        for (let i = 0; i <= state.controls.length; i += 1) {
          await ui.key('Tab', modifiers)
          await ui.afterPaint()
          assert(
            (await ui.snapshot()).dialogs.some((dialog) => dialog.ownsFocus),
            'Tab remains in active modal',
          )
        }
      await ui.key('Escape')
      const trigger = await ui.call('label', 'settings.title')
      const closed = await ui.waitFor(
        (s) => s.dialogs.length === 0 && s.focus === trigger,
        'modal dismissed and trigger focused',
      )
      assert.equal(closed.focus, await ui.call('label', 'settings.title'))
      assert.equal(closed.prompt, 'Retain draft through modal keyboard navigation')
    },
  },
  {
    name: 'daily/model-popup-dismiss',
    coverage: ['NAV-05'],
    async run(ui) {
      await type(ui, 'Retain draft while dismissing the model popup')
      await ui.click({ role: 'button', key: 'model.aria', contains: true })
      const label = await ui.call('label', 'model.menuModel')
      await ui.waitFor((s) => s.controls.some((c) => c.name.startsWith(label)), 'model popup')
      await ui.click(prompt)
      await ui.waitFor(
        (s) => !s.controls.some((c) => c.name.startsWith(label) && c.role === 'menuitem'),
        'outside dismissal',
      )
      await ui.click({ role: 'button', key: 'model.aria', contains: true })
      await ui.key('Escape')
      const state = await ui.snapshot()
      assert.equal(state.prompt, 'Retain draft while dismissing the model popup')
      assert.equal(state.configuration.model.modelId, 'fixture-model')
    },
  },
  {
    name: 'daily/narrow-composer',
    coverage: ['AX-01', 'AX-02', 'NAV-06'],
    async run(ui) {
      await ui.viewport(390, 480)
      await type(ui, '窄窗口仍可发送；长标签不会遮挡操作。'.repeat(12))
      await ui.click({ role: 'button', key: 'model.aria', contains: true })
      await ui.click({ role: 'menuitem', key: 'model.menuModel', contains: true })
      await ui.click({ role: 'button', name: 'Alternative model', contains: true })
      await ui.waitFor((s) => s.configuration.model.modelId === 'other-model', 'edge popup remains operable')
      await ui.click(prompt)
      await ui.key('Enter')
      const state = await ui.waitFor(
        (s) => s.receipts.length === 1 && s.prompt === '',
        'narrow composer sends',
      )
      assert(state.timeline.includes('窄窗口仍可发送'))
    },
  },
]
