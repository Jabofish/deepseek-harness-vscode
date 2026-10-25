export type StateSubscription<State> =
  readonly (keyof State)[] | { readonly exclude: readonly (keyof State)[] }

interface Subscriber {
  readonly notify: () => void
  active: boolean
}

/** Notify only consumers of changed state fields; publication stays synchronous. */
export class StateSubscriptions<State extends object> {
  private readonly all = new Set<Subscriber>()
  private readonly excluded = new Map<Subscriber, ReadonlySet<keyof State>>()
  private readonly fields = new Map<keyof State, Set<Subscriber>>()

  public subscribe(notify: () => void, state: State, subscription?: StateSubscription<State>): () => void {
    const subscriber: Subscriber = { notify, active: true }
    void state
    const exclusion =
      subscription !== undefined && 'exclude' in subscription ? new Set(subscription.exclude) : undefined
    const keys =
      subscription === undefined || exclusion !== undefined
        ? undefined
        : (subscription as readonly (keyof State)[])
    if (exclusion !== undefined) this.excluded.set(subscriber, exclusion)
    const memberships: Set<Subscriber>[] = []
    if (keys === undefined && exclusion === undefined) memberships.push(this.all)
    else if (keys !== undefined)
      for (const key of new Set(keys)) {
        let listeners = this.fields.get(key)
        if (listeners === undefined) {
          listeners = new Set()
          this.fields.set(key, listeners)
        }
        memberships.push(listeners)
      }
    for (const listeners of memberships) listeners.add(subscriber)
    return () => {
      subscriber.active = false
      this.excluded.delete(subscriber)
      for (const listeners of memberships) listeners.delete(subscriber)
    }
  }

  public publish(previous: State, next: State): void {
    if (previous === next) return
    const changed = new Set([...Object.keys(previous), ...Object.keys(next)] as (keyof State)[])
    const affected = new Set(this.all)
    const changedKeys: (keyof State)[] = []
    for (const key of changed) {
      if (Object.is(previous[key], next[key])) continue
      changedKeys.push(key)
      for (const subscriber of this.fields.get(key) ?? []) affected.add(subscriber)
    }
    for (const [subscriber, excluded] of this.excluded)
      if (changedKeys.some((key) => !excluded.has(key))) affected.add(subscriber)
    for (const subscriber of affected) if (subscriber.active) subscriber.notify()
  }

  public clear(): void {
    for (const subscriber of this.all) subscriber.active = false
    for (const listeners of this.fields.values())
      for (const subscriber of listeners) subscriber.active = false
    for (const subscriber of this.excluded.keys()) subscriber.active = false
    this.excluded.clear()
    this.all.clear()
    this.fields.clear()
  }
}
