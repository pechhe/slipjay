export type MachineWait = { place: number | null; waitedMs: number };

/**
 * Which of each machine's places this runner's gates hold, and the queue for them (SJ-200). A gate that finds every
 * place of its machine held waits, in arrival order, rather than opening boat; a released place is handed straight to
 * the gate that has waited longest. Boat is only for a machine whose places are down.
 */
export function machinePlaceHolds(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const held = new Map<string, Set<number>>();
  const queues = new Map<string, Array<(place: number | null) => void>>();
  const holding = (name: string) => held.get(name) ?? held.set(name, new Set()).get(name)!;
  const queue = (name: string) => queues.get(name) ?? queues.set(name, []).get(name)!;
  return {
    /** Whether `place` of the machine is held by a gate here. */
    holds: (name: string, place: number) => holding(name).has(place),
    /** Whether any place of the machine is held, so a gate finding no free one waits rather than using boat. */
    anyHeld: (name: string) => holding(name).size > 0,
    /** Whether gates are already queued for the machine, so a newcomer does not overtake them. */
    queued: (name: string) => queue(name).length > 0,
    /** Takes the first of `places` that is not held and that `usable` accepts; null when there is none. */
    take(name: string, places: number, usable: (place: number) => boolean): number | null {
      for (let place = 0; place < places; place++) {
        if (holding(name).has(place) || !usable(place)) continue;
        holding(name).add(place);
        return place;
      }
      return null;
    },
    /** Hands the place to the gate that has waited longest, which then holds it, or frees it when none waits. */
    release(name: string, place: number) {
      const next = queue(name).shift();
      if (next) next(place);
      else holding(name).delete(place);
    },
    /**
     * Frees a place that went down without handing it on, and wakes every waiting gate to look again: each takes a
     * usable place, queues again while another is held, or uses boat once none is. Handing a down place on would pass
     * it between waiters forever.
     */
    free(name: string, place: number) {
      holding(name).delete(place);
      for (const wake of queue(name).splice(0)) wake(null);
    },
    /**
     * Waits until a place of the machine is handed to this gate, which then holds it and must release it, or until it is
     * woken to look again (`place` null, not aborted), or stops at once when `signal` aborts: the queue passes one that aborts when the attempt is superseded or cancelled, or its
     * exact prefix is invalidated. A gate that stops leaves the queue without taking a place.
     */
    async wait(name: string, signal: AbortSignal): Promise<MachineWait> {
      const started = now();
      if (signal.aborted) return { place: null, waitedMs: 0 };
      const place = await new Promise<number | null>((resolve) => {
        const wake = (handed: number | null) => { signal.removeEventListener("abort", stop); resolve(handed); };
        const stop = () => {
          const waiting = queue(name), index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          resolve(null);
        };
        queue(name).push(wake);
        signal.addEventListener("abort", stop, { once: true });
      });
      return { place, waitedMs: now() - started };
    },
  };
}
