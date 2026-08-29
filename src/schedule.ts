import type { Tick } from './registry.ts'

/**
 * The slack the scheme runs on, as a fraction of the interval: how far
 * registrations are kept from the interval edges, and how far past the slot it
 * was due in a worker may drift before it stands down.
 */
export const GAP = 0.15

/**
 * Where in the interval a worker should register, as a fraction of it.
 *
 * Spreading the group evenly takes the ordering out of the hands of network
 * jitter: a worker holding index 2 of 5 fires third and is handed index 2
 * again. The loop is self-reinforcing, so a stable group keeps its assignment,
 * a join shifts only the workers after the insertion point, and two workers
 * that do collide are handed different indices and separate on the next
 * interval.
 *
 * The spread covers `interval - 2 * gap`, leaving `gap` at either end, so that
 * no worker sits on a boundary where a little jitter would land it in the
 * neighbouring key.
 *
 * The count can lag the index by one interval when the group has just grown,
 * so the divisor is whichever of the two is larger.
 */
export const phase = (index: number, replicas: number | null, gap: number): number => {
  const of = Math.max(replicas ?? 0, index + 1)

  return gap + ((index + 0.5) / of) * (1 - 2 * gap)
}

/**
 * The local time at which to register next.
 *
 * Interval boundaries are the server's, so the target is worked out in the
 * server's time domain and then shifted back by the offset this call just
 * measured — which keeps a worker's own clock out of the arithmetic.
 */
export const nextRegistration = (
  tick: Tick,
  interval: number,
  gap: number,
  now: number
): number => {
  // Until a count is known there is nothing to spread against, so the worker
  // keeps whatever phase it happened to start at.
  if (tick.replicas === null) return now + interval

  const offset = tick.at - now
  const start = (tick.interval + 1) * interval

  return start + phase(tick.index, tick.replicas, gap) * interval - offset
}
