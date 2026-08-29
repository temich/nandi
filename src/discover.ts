import { redisRegistry, type RedisLike, type Registry, type Tick } from './registry.ts'

/**
 * The pair a worker partitions by: `task.id % n === i`.
 *
 * `{ i: null, n: null }` means the worker owns nothing right now — it has just
 * started, or it has lost its registration — and must not consume.
 */
export type Peer = { i: number; n: number } | { i: null; n: null }

export interface DiscoverOptions {
  /** An ioredis or node-redis client. Mutually exclusive with `registry`. */
  redis?: RedisLike
  /** A registry of your own, in place of `redis`. */
  registry?: Registry
  /** Worker group name, for example `mail-sender`. */
  name: string
  /** Interval length in milliseconds. See the README on choosing one. */
  interval: number
  /** How long interval keys live. Defaults to three intervals. */
  ttl?: number
  /** Prepended to the key, for namespacing. */
  prefix?: string
}

const IDLE: Peer = { i: null, n: null }

/** What the worker carries between calls: its index, and the interval it is for. */
interface Held {
  interval: number
  index: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Both values must come from the same completed interval. The held index is
 * usable only when it belongs to `N-1`, which is also what keeps a worker that
 * has just joined, stalled or restarted from claiming a slot it never had.
 *
 * `index < replicas` guards the abnormal case where the previous key expired or
 * was evicted, leaving a count too small to contain the index.
 */
export const pair = (held: Held | null, tick: Tick): Peer =>
  held !== null &&
  held.interval === tick.interval - 1 &&
  tick.replicas !== null &&
  held.index < tick.replicas
    ? { i: held.index, n: tick.replicas }
    : IDLE

const same = (a: Peer, b: Peer) => a.i === b.i && a.n === b.n

const registryFor = (options: DiscoverOptions): Registry => {
  if (options.registry) return options.registry
  if (!options.redis) throw new TypeError('n-and-i: discover needs either `redis` or `registry`')

  return redisRegistry(options.redis, {
    name: options.name,
    interval: options.interval,
    ttl: options.ttl ?? options.interval * 3,
    prefix: options.prefix,
  })
}

/**
 * Yields the worker's `(i, n)` pair, and yields again whenever it changes — so
 * the body of the loop is the point at which to drain in-flight work and adopt
 * the new mapping.
 */
export async function* discover(options: DiscoverOptions): AsyncGenerator<Peer> {
  const registry = registryFor(options)

  let held: Held | null = null
  let applied: Peer = IDLE

  yield applied

  for (;;) {
    const tick = await registry.register()
    const next = pair(held, tick)

    held = { interval: tick.interval, index: tick.index }

    if (!same(applied, next)) {
      applied = next
      yield next
    }

    await sleep(options.interval)
  }
}
