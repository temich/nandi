import type { Tick } from './registry.ts'

/**
 * Registrations are kept away from the interval edges, so that no worker sits
 * on a boundary where a little jitter would land it in the neighbouring key.
 */
const LOW = 0.1
const HIGH = 0.9

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
 * The count can lag the index by one interval when the group has just grown,
 * so the divisor is whichever of the two is larger.
 */
export const phase = (index: number, replicas: number | null): number => {
  const of = Math.max(replicas ?? 0, index + 1)

  return LOW + ((index + 0.5) / of) * (HIGH - LOW)
}

/**
 * The local time at which to register next.
 *
 * Interval boundaries are the server's, so the target is worked out in the
 * server's time domain and then shifted back by the offset this call just
 * measured — which keeps a worker's own clock out of the arithmetic.
 */
export const nextRegistration = (tick: Tick, interval: number, now: number): number => {
  // Until a count is known there is nothing to spread against, so the worker
  // keeps whatever phase it happened to start at.
  if (tick.replicas === null) return now + interval

  const offset = tick.at - now
  const start = (tick.interval + 1) * interval

  return start + phase(tick.index, tick.replicas) * interval - offset
}
