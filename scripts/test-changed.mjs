import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const contracts = [
  'tests/marketplace-retry.spec.ts',
  'apps/webview/src/app/store-realtime-delivery.spec.ts',
  'apps/webview/src/app/store/feature-actions.tasks.spec.ts',
  'apps/extension/src/tasks/task-center-registry.spec.ts',
  'apps/webview/src/App.connected.spec.tsx',
  'apps/webview/src/features/shell/AppNotices.spec.tsx',
  'apps/webview/src/components/common/useScrollFollow.spec.tsx',
  'apps/webview/src/features/chat/Timeline.spec.tsx',
  'apps/webview/src/features/billing/Billing.spec.tsx',
  'apps/webview/src/features/inspector/SessionInspector.spec.tsx',
  'apps/webview/src/components/common/useDismissibleLayer.spec.tsx',
  'apps/webview/src/features/schedules/ScheduleDrawer.spec.tsx',
  'apps/webview/src/app/store-subagent.spec.ts',
  'apps/webview/src/app/store-surface.spec.ts',
  'apps/extension/src/view/message-router-surface.spec.ts',
  'apps/extension/src/composition/request-gateway-trust.spec.ts',
  'apps/webview/src/styles',
  'packages/ui/src/motion-tokens.spec.ts',
  'apps/webview/src/i18n-keys.spec.ts',
  'apps/extension/src/view/protocol-route-coverage.spec.ts',
  'apps/extension/src/build/import-meta-url.spec.ts',
  'apps/extension/src/view/transcript-window-registry.spec.ts',
  'tests/webview-transcript-boundary.spec.ts',
  'apps/extension/src/view/session-drop-editor.spec.ts',
  'apps/extension/src/commands/command-manifest.spec.ts',
  'apps/webview/src/app/native-titlebar-layout.spec.ts',
]

const argument = process.argv.slice(2).find((value) => value !== '--list')
let files = contracts
if (argument !== '--contracts') {
  const selection = spawnSync(
    process.execPath,
    [vitest, 'list', '--filesOnly', '--json', '--changed', ...(argument ? [argument] : [])],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  if (selection.error) throw selection.error
  if (selection.status !== 0) process.exit(selection.status ?? 1)
  const changed = JSON.parse(selection.stdout)
  if (!Array.isArray(changed) || !changed.every((entry) => entry && typeof entry.file === 'string'))
    throw new Error('Invalid Vitest file selection')
  files = [
    ...new Set([...changed.map((entry) => entry.file), ...contracts].map((file) => resolve(root, file))),
  ]
}
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(files))
  process.exit(0)
}
const filters = files.map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/'))
// A large changed set must also fit Windows' command-line limit.
const args = filters.join(' ').length > 24_000 ? [] : filters
const run = spawnSync(process.execPath, [vitest, 'run', ...args], { cwd: root, stdio: 'inherit' })
if (run.error) throw run.error
process.exitCode = run.status ?? 1
