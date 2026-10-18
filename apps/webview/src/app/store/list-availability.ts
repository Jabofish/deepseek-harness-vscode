/** A valid current snapshot also settles the failure of an earlier advisory read. */
export function withAvailableList<T extends { readonly unavailableLists?: readonly string[] }>(
  state: T,
  key: string,
): T {
  if (!state.unavailableLists?.includes(key)) return state
  return { ...state, unavailableLists: state.unavailableLists.filter((entry) => entry !== key) }
}
