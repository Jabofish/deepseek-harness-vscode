import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'
import {
  discoverCandidateTestFiles,
  listGitChangedFiles,
  selectAffectedTests,
} from './changed-test-selection.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const contracts = [
  'tests/marketplace-retry.spec.ts',
  'tests/publish-marketplace.spec.ts',
  'apps/webview/src/app/store-realtime-delivery.spec.ts',
  'apps/webview/src/app/store/feature-actions.tasks.spec.ts',
  'apps/extension/src/tasks/task-center-registry.spec.ts',
  'apps/webview/src/App.connected.spec.tsx',
  'apps/webview/src/app/question-lifecycle.spec.tsx',
  'apps/extension/src/composition/interaction-response-transport.spec.ts',
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
  'apps/webview/src/i18n-keys.spec.ts',
  'apps/extension/src/build/import-meta-url.spec.ts',
  'apps/extension/src/view/transcript-window-registry.spec.ts',
  'apps/extension/src/view/session-drop-editor.spec.ts',
  'apps/extension/src/commands/command-manifest.spec.ts',
]

const argument = process.argv.slice(2).find((value) => value !== '--list')
let files = contracts
if (argument !== '--contracts') {
  const changed = selectAffectedTests({
    root,
    changedFiles: listGitChangedFiles(root, argument),
    candidateTests: discoverCandidateTestFiles(root, process.env),
  })
  files = [...new Set([...changed, ...contracts].map((file) => resolve(root, file)))]
}
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(files))
  process.exit(0)
}
const filters = files.map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/'))
// Keep the selection in memory so it never has to fit the OS command line.
const { startVitest } = await import('vitest/node')
process.chdir(root)
await startVitest('test', filters, { root, run: true })
