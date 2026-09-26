/** Run each disposal step even when an earlier step fails, preserving all failures. */
export async function runCleanupSequence(actions: readonly (() => unknown)[]): Promise<readonly unknown[]> {
  const errors: unknown[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}
