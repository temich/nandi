import { redisRegistry, type RedisLike, type Registry, type Tick } from './registry.ts'
import { GAP, nextRegistration } from './schedule.ts'

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
  /**
   * The slack the scheme runs on, as a fraction of the interval, between 0 and
   * 0.5. Registrations stay this far from the interval edges, and a worker
   * stands down this far past the slot it was due in. Defaults to `0.15`.
   */
  gap?: number
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
 * The pair a completed interval implies — the first of the two conditions on
 * owning a slot, the second being that the interval before it implied the same
 * pair.
 *
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
 * nature and never surface as exceptions; a registration that fails or hangs
 * past the slot it was due in yields the idle pair instead, so a worker that
 * Redis has stopped counting stops consuming.
 */
export async function* discover(options: DiscoverOptions): AsyncGenerator<Peer> {
  const registry = registryFor(options)
  const { interval, signal } = options
  const gap = options.gap ?? GAP

  if (!(gap > 0 && gap < 0.5))
    throw new RangeError(`n-and-i: \`gap\` must be between 0 and 0.5, got ${gap}`)

  if (signal?.aborted) return

  let held: Held | null = null
  let previous: Peer = IDLE
  let applied: Peer = IDLE
  let mailbox: Peer | null = null
  let deliver: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let stale: ReturnType<typeof setTimeout> | undefined
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
    clearTimeout(stale)
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

  /**
   * Standing down runs on its own timer rather than off the back of a failed
   * attempt, because a registration that never returns is as much a loss of the
   * registration as one that throws, and nothing on the error path would see
   * it. Missing the slot it planned for leaves the worker where a restart would:
   * no index from a closed interval, and nothing agreed to pair it with.
   *
   * Reusing the gap for this rather than a second number is what keeps the
   * scheme sound. Owning a slot rests on the group spanning no more than two
   * consecutive intervals, and a worker that missed a registration outright is
   * a third: due at `1 - gap` at the latest, it has to be gone before the
   * earliest worker takes up the newer mapping at `gap` of the interval after.
   * That holds for any gap, because standing down `gap` late always beats the
   * `2 * gap` the band leaves for it.
   */
  const arm = (ms: number) => {
    clearTimeout(stale)

    stale = setTimeout(() => {
      held = null
      previous = IDLE
      publish(IDLE)
    }, ms)
  }

  signal?.addEventListener('abort', stop, { once: true })

  const driver = (async () => {
    let attempt = 0

    arm(interval * (1 + gap))

    for (;;) {
      if (done) break

      let delay = interval

      try {
        const tick = await registry.register()
        const now = Date.now()
        const next = pair(held, tick)

        // Two agreeing intervals before owning anything. A pair that has just
        // changed is not yet held by the whole group, and taking it up while a
        // worker that has not registered this interval is still on the old one
        // is what would put two mappings live at once.
        publish(same(next, previous) ? next : IDLE)

        previous = next
        held = { interval: tick.interval, index: tick.index }
        attempt = 0
        delay = Math.max(0, nextRegistration(tick, interval, gap, now) - now)
        arm(delay + interval * gap)
      } catch {
        attempt += 1
        delay = backoff(interval, attempt)
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

    // Standing down is the last ownership change. Handing the body one final
    // idle pass runs whatever it already does on losing registration, so the
    // loop cannot end while the worker still owns a slot. Only an aborted
    // signal reaches this: `break` leaves through the consumer, and a generator
    // cannot yield once that has happened.
    if (applied.i !== null) {
      applied = IDLE

      yield IDLE
    }
  } finally {
    stop()
    signal?.removeEventListener('abort', stop)
    await driver
  }
}
