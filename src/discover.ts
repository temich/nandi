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
  /** Stops the loop, as `break` does. */
  signal?: AbortSignal
}

const IDLE: Peer = { i: null, n: null }

/** What the worker carries between calls: its index, and the interval it is for. */
interface Held {
  interval: number
  index: number
}

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

/** Retry sooner than the next interval, backing off, so a blip costs less than a cycle. */
const backoff = (interval: number, attempt: number) =>
  Math.min(interval, (interval / 8) * 2 ** (attempt - 1))

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
 *
 * Registration runs on its own schedule, independently of how fast the body of
 * the loop is: a slow consumer never delays it, and simply sees the latest pair
 * rather than a queue of stale ones. Registration failures are transient by
 * nature and never surface as exceptions; losing the registration for a whole
 * interval yields the idle pair instead, so a worker that Redis has stopped
 * counting stops consuming.
 */
export async function* discover(options: DiscoverOptions): AsyncGenerator<Peer> {
  const registry = registryFor(options)
  const { interval, signal } = options

  if (signal?.aborted) return

  let held: Held | null = null
  let applied: Peer = IDLE
  let mailbox: Peer | null = null
  let deliver: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let interrupt: (() => void) | null = null
  let done = false

  /** A single slot, not a queue: an unread pair is replaced, never stacked. */
  const publish = (peer: Peer) => {
    if (same(applied, peer)) return

    applied = peer
    mailbox = peer
    deliver?.()
    deliver = null
  }

  const stop = () => {
    done = true
    clearTimeout(timer)
    interrupt?.()
    interrupt = null
    deliver?.()
    deliver = null
  }

  const wait = (ms: number) =>
    new Promise<void>(resolve => {
      interrupt = resolve
      timer = setTimeout(resolve, ms)
    })

  signal?.addEventListener('abort', stop, { once: true })

  const driver = (async () => {
    let attempt = 0
    let registered = Date.now()

    for (;;) {
      if (done) break

      let delay = interval

      try {
        const tick = await registry.register()

        publish(pair(held, tick))
        held = { interval: tick.interval, index: tick.index }
        attempt = 0
        registered = Date.now()
      } catch {
        attempt += 1
        delay = backoff(interval, attempt)

        // A whole interval with no successful registration means the group has
        // stopped counting this worker; it must not keep consuming.
        if (Date.now() - registered >= interval) publish(IDLE)
      }

      if (done) break

      await wait(delay)
    }
  })().catch(() => {
    // Registration errors are handled in the loop; this guards the loop itself.
  })

  try {
    yield IDLE

    for (;;) {
      if (done) break

      if (mailbox !== null) {
        const next = mailbox
        mailbox = null

        yield next
        continue
      }

      await new Promise<void>(resolve => {
        deliver = resolve
      })
    }
  } finally {
    stop()
    signal?.removeEventListener('abort', stop)
    await driver
  }
}
