/** Replaced when building the companion shipped by the VS Code extension. */
declare const __DSH_EDITOR_BUILD_ID__: string
export const COMPANION_BUILD_ID =
  typeof __DSH_EDITOR_BUILD_ID__ === 'string' ? __DSH_EDITOR_BUILD_ID__ : 'source'
