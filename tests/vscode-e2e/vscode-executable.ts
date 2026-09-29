/**
 * Resolves the VS Code executable the E2E runner launches.
 *
 * `@vscode/test-electron` downloads and unpacks a VS Code build whenever
 * `vscodeExecutablePath` is absent, so a missing override silently turns a
 * local run into a network download. The runner is documented as using a
 * locally installed VS Code, so the override is required rather than optional.
 */
export function resolveVscodeExecutable(requested: string | undefined): string {
  const value = requested?.trim() ?? ''
  if (value === '')
    throw new Error(
      'DSH_VSCODE_E2E_EXECUTABLE is not set. ' +
        'Set it to a local VS Code executable (Code.exe on Windows, the code binary elsewhere); ' +
        'this runner never downloads VS Code.',
    )
  return value
}
