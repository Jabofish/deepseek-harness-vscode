export interface SessionConfigurationController {
  readonly nextConfigurationGeneration: () => number
  readonly isConfigurationGenerationCurrent: (generation: number) => boolean
  readonly nextPresetRosterGeneration: () => number
  readonly isPresetRosterCurrent: (generation: number) => boolean
}

/** Explicit configuration writes and catalog reads have independent generations. */
export function createSessionConfigurationController(): SessionConfigurationController {
  let configurationGeneration = 0
  let presetRosterGeneration = 0
  return {
    nextConfigurationGeneration: () => ++configurationGeneration,
    isConfigurationGenerationCurrent: (generation) => generation === configurationGeneration,
    nextPresetRosterGeneration: () => ++presetRosterGeneration,
    isPresetRosterCurrent: (generation) => generation === presetRosterGeneration,
  }
}
