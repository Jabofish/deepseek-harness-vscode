import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearTimeout } from 'node:timers'
import { build } from 'esbuild'
import {
  stabilityScenarios,
  runStabilityScenario,
  shortConversationScenario,
} from './ui-stability-scenarios.mjs'
import { dailyScenarios } from './ui-daily-scenarios.mjs'
import { uiBehaviorSuites } from './ui-behavior-suites.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert(
  process.env.DSH_UI_GROUP === undefined || process.env.DSH_UI_GROUP === 'daily',
  'DSH_UI_GROUP must be daily or unset',
)
const names = [
  ...stabilityScenarios.map((test) => test.name),
  'short-conversation/wheel-then-output',
  ...dailyScenarios.map((test) => test.name),
]
assert.equal(new Set(names).size, names.length, 'UI scenarios must have distinct names')
if (process.env.DSH_UI_SCENARIO) {
  assert(names.includes(process.env.DSH_UI_SCENARIO), 'Unknown DSH_UI_SCENARIO')
  assert(
    process.env.DSH_UI_GROUP !== 'daily' ||
      dailyScenarios.some((test) => test.name === process.env.DSH_UI_SCENARIO),
    'Requested scenario does not belong to the daily group',
  )
}
const evidence = join(
  root,
  'artifacts',
  'ui-stability-browser',
  new Date().toISOString().replace(/[:.]/gu, '-'),
)
const output = join(evidence, 'bundle')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const candidates = process.env.DSH_UI_BROWSER
  ? [process.env.DSH_UI_BROWSER]
  : process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
        join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Microsoft/Edge/Application/msedge.exe',
        ),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
let executable
for (const candidate of candidates) {
  if (
    await access(candidate).then(
      () => true,
      () => false,
    )
  ) {
    executable = candidate
    break
  }
}
assert(executable, 'Set DSH_UI_BROWSER to an installed Chrome, Chromium or Edge executable')
await mkdir(output, { recursive: true })
let behavior
if (!process.env.DSH_UI_SCENARIO && !process.env.DSH_UI_GROUP) {
  const files = [...new Set(Object.values(uiBehaviorSuites).flat())]
  const reportPath = join(evidence, 'behavior-results.json')
  const tests = spawn(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      ...files,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    { cwd: root, windowsHide: true, stdio: 'inherit' },
  )
  const code = await new Promise((done, reject) => {
    tests.once('error', reject)
    tests.once('close', done)
  })
  assert.equal(code, 0, 'Functional UI behavior tests failed')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert(report.numPassedTests > 0, 'No functional UI behavior tests ran')
  assert.equal(report.numPendingTests, 0, 'Functional UI behavior tests must not be skipped')
  for (const file of files) {
    const result = report.testResults.find((result) => resolve(result.name) === resolve(root, file))
    assert(
      result?.assertionResults.some((test) => test.status === 'passed'),
      `No passed tests for ${file}`,
    )
  }
  behavior = { passed: report.numPassedTests, failed: report.numFailedTests, suites: uiBehaviorSuites }
  console.log(`${behavior.passed} functional UI checks passed across ${files.length} files`)
} else {
  console.log('Targeted browser run; functional UI behavior suites are omitted')
}
await build({
  entryPoints: [
    join(root, 'apps/webview/src/test-support/timeline-browser.tsx'),
    join(root, 'apps/webview/src/test-support/app-browser.ts'),
  ],
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: output,
  jsx: 'automatic',
  nodePaths: [join(root, 'apps/webview/node_modules')],
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  logLevel: 'warning',
})
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/' || request.url?.startsWith('/app?')) {
      const entry = request.url === '/' ? 'timeline-browser' : 'app-browser'
      response.setHeader('content-type', 'text/html')
      response.end(
        `<!doctype html><html><head><link rel="stylesheet" href="/${entry}.css"></head><body><div id="root"></div><script type="module" src="/${entry}.js"></script></body></html>`,
      )
      return
    }
    const path = resolve(output, `.${request.url ?? '/'}`)
    if (!path.startsWith(`${output}${sep}`)) {
      response.writeHead(403)
      response.end()
      return
    }
    response.setHeader(
      'content-type',
      extname(path) === '.js'
        ? 'text/javascript'
        : extname(path) === '.css'
          ? 'text/css'
          : 'application/octet-stream',
    )
    response.end(await readFile(path))
  })().catch(() => {
    response.writeHead(404)
    response.end()
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const profile = await mkdtemp(join(tmpdir(), 'dsh-ui-stability-'))
const browser = spawn(
  executable,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--window-size=1100,850',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
)
let launchError
browser.on('error', (error) => {
  launchError = error
})
const closed = new Promise((done) => browser.once('close', done))
let socket
const results = []
const errors = []
const pending = new Map()
try {
  let port
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (launchError) throw new Error('Browser launch failed', { cause: launchError })
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      break
    } catch {
      await delay(100)
    }
  }
  assert(port, 'Browser did not start its isolated debugging endpoint')
  const pages = await (await globalThis.fetch(`http://127.0.0.1:${port}/json`)).json()
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.done(message.result)
  })
  const send = (method, params = {}) =>
    new Promise((done, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 15_000)
      pending.set(id, { done, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }

  const act = (action, ...args) =>
    evaluate('timelineScenario[' + JSON.stringify(action) + '](...' + JSON.stringify(args) + ')')
  const afterPaint = () => evaluate('new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)))')
  const settle = () => act('settle')
  const snapshot = () => act('snapshot')
  const wheelAt = (gesture) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, ...gesture })
  const wheel = async (scale = 1) => {
    const gesture = await act('wheelPoint')
    await wheelAt({ ...gesture, deltaY: gesture.deltaY * scale })
  }
  const key = async (name) => {
    const code = name === 'PageUp' ? 33 : 34
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
    })
  }
  await send('Runtime.enable')
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate('!!window.timelineScenario')) break
    await delay(100)
  }
  assert(await evaluate('!!window.timelineScenario'), 'The conversation fixture did not mount')
  const selected = stabilityScenarios.filter(
    (test) =>
      process.env.DSH_UI_GROUP !== 'daily' &&
      (!process.env.DSH_UI_SCENARIO || test.name === process.env.DSH_UI_SCENARIO),
  )
  assert(
    selected.length ||
      process.env.DSH_UI_GROUP === 'daily' ||
      process.env.DSH_UI_SCENARIO === 'short-conversation/wheel-then-output' ||
      dailyScenarios.some((test) => test.name === process.env.DSH_UI_SCENARIO),
    'Unknown DSH_UI_SCENARIO',
  )
  for (const turns of [8, 11, 80])
    for (const layout of ['classic', 'focused']) {
      const ui = { act, afterPaint, settle, snapshot, wheelAt, wheel, key, turns, layout }
      for (const test of selected) {
        try {
          const observations = await runStabilityScenario(ui, test)
          results.push({ turns, layout, scenario: test.name, status: 'PASS', ...observations })
        } catch (error) {
          const samples = await act('stopObservation').catch(() => [])
          const screenshot = await send('Page.captureScreenshot', { format: 'png' })
          const image = 'failure-' + results.length + '.png'
          await writeFile(join(evidence, image), Buffer.from(screenshot.data, 'base64'))
          results.push({
            turns,
            layout,
            scenario: test.name,
            status: 'FAIL',
            error: error instanceof Error && 'detail' in error ? error.detail : String(error),
            after: await snapshot(),
            samples,
            ...(error instanceof Error && 'observations' in error ? error.observations : {}),
            screenshot: image,
          })
          console.error(`${turns}/${layout}/${test.name}: ${String(error)}`)
        }
        await appendFile(join(evidence, 'progress.jsonl'), `${JSON.stringify(results.at(-1))}\n`)
      }
      console.log(`${turns}/${layout}: ${selected.length} scenarios complete`)
    }
  if (
    process.env.DSH_UI_GROUP !== 'daily' &&
    (!process.env.DSH_UI_SCENARIO || process.env.DSH_UI_SCENARIO === 'short-conversation/wheel-then-output')
  )
    for (const layout of ['classic', 'focused']) {
      const ui = { act, afterPaint, settle, snapshot, wheelAt, wheel, key, layout }
      try {
        results.push({
          layout,
          scenario: 'short-conversation/wheel-then-output',
          status: 'PASS',
          ...(await shortConversationScenario(ui)),
        })
      } catch (error) {
        results.push({
          layout,
          scenario: 'short-conversation/wheel-then-output',
          status: 'FAIL',
          error: String(error),
        })
      }
    }
  const dailySelected = dailyScenarios.filter(
    (test) => !process.env.DSH_UI_SCENARIO || test.name === process.env.DSH_UI_SCENARIO,
  )
  for (const test of dailySelected)
    for (const layout of ['classic', 'focused']) {
      const locale = layout === 'classic' ? 'en' : 'zh'
      const caseName = `${test.name}/${layout}/${locale}`
      const call = (action, ...args) =>
        evaluate('dailyUi[' + JSON.stringify(action) + '](...' + JSON.stringify(args) + ')')
      const waitFor = async (predicate, description) => {
        const started = Date.now()
        while (Date.now() - started < 8000) {
          const state = await call('snapshot')
          if (predicate(state)) return state
          await delay(50)
        }
        throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(await call('snapshot'))}`)
      }
      const click = async (target) => {
        const point = await call('point', target)
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...point,
          button: 'left',
          clickCount: 1,
        })
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...point,
          button: 'left',
          clickCount: 1,
        })
      }
      const press = async (name, modifiers = 0) => {
        const codes = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowDown: 40, ArrowUp: 38, a: 65 }
        const code = codes[name] ?? 0
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: name,
          code: name === 'a' ? 'KeyA' : name,
          windowsVirtualKeyCode: code,
          modifiers,
        })
        if (name === 'Enter' && modifiers === 8)
          await send('Input.dispatchKeyEvent', {
            type: 'char',
            text: '\r',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            modifiers,
          })
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: name,
          code: name === 'a' ? 'KeyA' : name,
          windowsVirtualKeyCode: code,
          modifiers,
        })
      }
      const ui = {
        call,
        waitFor,
        click,
        key: press,
        afterPaint,
        type: (value) => send('Input.insertText', { text: value }),
        compose: (text) =>
          send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }),
        viewport: (width, height) =>
          send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
        snapshot: () => call('snapshot'),
        capture: async (name) => {
          assert(/^[a-z0-9-]+$/u.test(name))
          await evaluate(
            'Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)))',
          )
          const screenshot = await send('Page.captureScreenshot', { format: 'png' })
          await writeFile(
            join(evidence, `${name}-${layout}-${locale}.png`),
            Buffer.from(screenshot.data, 'base64'),
          )
        },
        locale,
        layout,
      }
      try {
        await send('Emulation.clearDeviceMetricsOverride')
        await send('Page.navigate', {
          url: `http://127.0.0.1:${server.address().port}/app?case=${encodeURIComponent(caseName)}&layout=${layout}&locale=${locale}`,
        })
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await evaluate('!!window.dailyUi')) break
          await delay(50)
        }
        await waitFor(
          (state) =>
            state.timeline?.includes('Answer owned by Alpha conversation') && state.prompt !== undefined,
          'initial session and composer',
        )
        await test.run(ui)
        results.push({ scenario: test.name, layout, locale, status: 'PASS', coverage: test.coverage })
      } catch (error) {
        const image = `failure-${results.length}.png`
        const screenshot = await send('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(evidence, image), Buffer.from(screenshot.data, 'base64'))
        results.push({
          scenario: test.name,
          layout,
          locale,
          status: 'FAIL',
          error: String(error),
          screenshot: image,
          state: await call('snapshot').catch(() => undefined),
        })
        console.error(`${caseName}: ${String(error)}`)
      }
      await appendFile(join(evidence, 'progress.jsonl'), `${JSON.stringify(results.at(-1))}\n`)
      console.log(`${caseName} complete`)
    }
  const report = {
    behavior,
    environment: { node: process.version, platform: process.platform },
    browser: await send('Browser.getVersion'),
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    errors,
    results,
  }
  await writeFile(join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'final.png'), Buffer.from(screenshot.data, 'base64'))
  console.log(
    `${report.passed} passed, ${report.failed} failed, ${errors.length} runtime errors. Evidence: ${relative(root, evidence)}`,
  )
  for (const result of results.filter((r) => r.status === 'FAIL')) console.error(result)
  if (report.failed || errors.length) process.exitCode = 1
  await send('Browser.close').catch(() => undefined)
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timer)
  browser.kill()
  await Promise.race([closed, delay(5_000)])
  await new Promise((done) => server.close(done))
  // Only remove the unique profile this invocation created inside the OS temp
  // directory. Generated evidence remains under artifacts for inspection.
  assert(
    dirname(profile) === resolve(tmpdir()) &&
      profile.startsWith(join(resolve(tmpdir()), 'dsh-ui-stability-')),
  )
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
