/** The durable routing descriptor one subagent catalog publishes for a child. */
export interface SubagentAddress {
  readonly parentSessionId: string
  readonly mode: 'one-shot' | 'continuable'
}

/**
 * Child-session routing shared by the catalog reader and the session reads.
 *
 * A subagent child is reachable only through the parent/mode descriptor the
 * catalog published for it: the Session Controller refuses a session-kind
 * address whose header is subagent-origin. The follow stream and the
 * snapshot/page pair therefore resolve every session id through this registry,
 * which keeps the wire addressing identical to the one the catalog committed.
 */
export class SubagentAddressRegistry {
  private readonly addresses = new Map<string, SubagentAddress>()

  public resolve(childSessionId: string): SubagentAddress | undefined {
    return this.addresses.get(childSessionId)
  }

  public parentOf(childSessionId: string): string | undefined {
    return this.addresses.get(childSessionId)?.parentSessionId
  }

  /** Commit one validated catalog: children of `parentSessionId` are replaced wholesale. */
  public replaceParent(
    parentSessionId: string,
    children: readonly { readonly id: string; readonly mode: 'one-shot' | 'continuable' }[],
  ): void {
    for (const [childId, address] of this.addresses)
      if (address.parentSessionId === parentSessionId) this.addresses.delete(childId)
    for (const child of children) this.addresses.set(child.id, { parentSessionId, mode: child.mode })
  }
}
