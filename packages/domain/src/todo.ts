/**
 * Marker used by the scaffold for deliberately unimplemented behavior.
 *
 * Every call must describe both the capability and the acceptance requirement.
 * The implementation phase replaces the call with production code and tests.
 */
export class TodoImplementationError extends Error {
  public constructor(
    public readonly feature: string,
    public readonly requirements: readonly string[],
  ) {
    super(`TODO: ${feature}. Requirements: ${requirements.join('; ')}`)
    this.name = 'TodoImplementationError'
  }
}

export function unimplemented<T>(feature: string, requirements: readonly string[]): T {
  throw new TodoImplementationError(feature, requirements)
}
