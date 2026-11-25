export declare const OFFLINE_LIVE_HARNESS_TESTS: readonly string[]
export declare const VITEST_SETUP_FILES: readonly string[]
export declare function listGitChangedFiles(root: string, changedSince?: string): string[]
export declare function isForceRerunTrigger(relativePath: string): boolean
export declare function discoverCandidateTestFiles(
  root: string,
  env?: Readonly<Record<string, string | undefined>>,
): string[]
export declare function extractModuleSpecifiers(filePath: string, source: string): string[]
export declare function selectAffectedTests(options: {
  readonly root: string
  readonly changedFiles: readonly string[]
  readonly candidateTests?: readonly string[]
}): string[]
