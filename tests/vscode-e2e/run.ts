import { unimplemented } from '../../packages/domain/src/todo.js'

export function run(): Promise<void> {
  return unimplemented<Promise<void>>('VS Code Electron end-to-end test runner', [
    'download the pinned minimum supported VS Code build through @vscode/test-electron',
    'create a unique temporary extension test workspace',
    'launch a deterministic loopback fake DSH fixture with recorded rc6 contracts',
    'execute the scenarios in tests/vscode-e2e/README.md',
    'terminate and delete only test-owned resources in finally blocks',
  ])
}
