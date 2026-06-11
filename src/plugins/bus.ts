// The extension spine — a small, typed pub/sub modeled on WordPress hooks:
//   • actions — fire-and-forget notifications (emit/on). Listeners observe; they can't change anything.
//   • filters — value transformers (apply/add): each registered fn receives the running value and
//                returns the next, so plugins can rewrite core data/UI and extend one another.
// Both take a numeric priority (lower runs first; default 10) and return a Disposable from on()/add()
// so a plugin's subscriptions are revoked when it unloads. Handler errors are logged, never thrown,
// so one bad plugin can't break a dispatch.

export type Disposable = { dispose(): void };

type Entry = { fn: (...args: unknown[]) => unknown; priority: number };

// Iterate a copy in priority order, so add/remove during a dispatch can't disturb the in-flight run.
const ordered = (list: Entry[]): Entry[] => [...list].sort((a, b) => a.priority - b.priority);

const actionMap = new Map<string, Entry[]>();
const filterMap = new Map<string, Entry[]>();

function register(map: Map<string, Entry[]>, name: string, fn: Entry['fn'], priority: number): Disposable {
  const list = map.get(name) ?? map.set(name, []).get(name)!;
  const entry: Entry = { fn, priority };
  list.push(entry);
  return {
    dispose() {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

export type Actions = {
  /** Notify every listener of `event` in priority order. */
  emit(event: string, payload?: unknown): void;
  /** Listen for `event`; returns a Disposable. */
  on(event: string, fn: (payload: unknown) => void, priority?: number): Disposable;
};

export type Filters = {
  /** Run `value` through every transform registered for `name` (priority order) and return the result. */
  apply<T>(name: string, value: T, ctx?: unknown): Promise<T>;
  /** Register a transform `(value, ctx) => nextValue`; returns a Disposable. */
  add<T>(name: string, fn: (value: T, ctx: unknown) => T | Promise<T>, priority?: number): Disposable;
};

export const actions: Actions = {
  emit(event, payload) {
    const list = actionMap.get(event);
    if (!list) return;
    for (const e of ordered(list)) {
      try {
        e.fn(payload);
      } catch (err) {
        console.error(`[bus] action "${event}" listener threw:`, err);
      }
    }
  },
  on(event, fn, priority = 10) {
    return register(actionMap, event, fn as Entry['fn'], priority);
  },
};

export const filters: Filters = {
  async apply(name, value, ctx) {
    const list = filterMap.get(name);
    if (!list) return value;
    let v = value;
    for (const e of ordered(list)) {
      try {
        v = (await e.fn(v, ctx)) as typeof v;
      } catch (err) {
        console.error(`[bus] filter "${name}" transform threw:`, err);
      }
    }
    return v;
  },
  add(name, fn, priority = 10) {
    return register(filterMap, name, fn as Entry['fn'], priority);
  },
};

/** Drop every subscription — the host calls this on HMR so reloaded modules don't double-register. */
export function resetBus() {
  actionMap.clear();
  filterMap.clear();
}
