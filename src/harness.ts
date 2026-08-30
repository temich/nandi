import assert from 'node:assert/strict'
import { Redis } from 'ioredis'
import { discover, type DiscoverOptions, type Peer } from './discover.ts'
import { redisRegistry, type Registry } from './registry.ts'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

/** Interval the suites run at. Slower machines want more; the library has no floor. */
export const INTERVAL = Number(process.env.TEST_INTERVAL ?? 300)

export const connect = () => new Redis(REDIS_URL)

let seq = 0

/** A group name no other test shares, so suites can run against one Redis. */
export const group = () => `nandi-test-${process.pid}-${++seq}`

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Polls `check` until it stops throwing, or gives up and rethrows. */
export const settle = async (check: () => unknown, timeout = 5000, step = 25) => {
  const deadline = Date.now() + timeout

  for (;;)
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error

      await sleep(step)
    }
}

export interface Fault {
  registry: Registry
  /** Fails the next `times` registrations, or every one until {@link Fault.heal}. */
  fail: (times?: number) => void
  /** Registrations rejected so far. */
  failures: () => number
  /**
   * Every subsequent registration hangs until {@link Fault.heal} — the case a
   * client with no command timeout leaves a worker in. How many attempts have
   * been swallowed so far is on {@link Fault.hanging}.
   */
  stall: () => void
  /** Registrations left hanging and not yet settled. */
  hanging: () => number
  /** Restores the registry, settling anything {@link Fault.stall} held open. */
  heal: () => void
}

/** Wraps a real registry so a test can cut it off and restore it. */
export const faulty = (inner: Registry): Fault => {
  let mode: 'well' | 'broken' | 'stalled' = 'well'
  let left = Infinity
  let failures = 0
  let held: ((reason: Error) => void)[] = []

  const hang = () =>
    new Promise<never>((_resolve, reject) => {
      held.push(reject)
    })

  return {
    registry: {
      register: () => {
        if (mode === 'broken' && left > 0) {
          left -= 1
          failures += 1

          return Promise.reject(new Error('injected outage'))
        }

        if (mode === 'stalled') return hang()

        return inner.register()
      },
    },
    fail: (times = Infinity) => {
      mode = 'broken'
      left = times
    },
    failures: () => failures,
    stall: () => {
      mode = 'stalled'
    },
    hanging: () => held.length,
    heal: () => {
      mode = 'well'
      left = Infinity

      // A real client rejects its in-flight commands when the connection goes;
      // leaving them pending would hang the worker's shutdown, and the test.
      const pending = held
      held = []

      for (const reject of pending) reject(new Error('injected outage'))
    },
  }
}

/** A pair the loop body was handed, and when it was handed it. */
export interface Handed {
  peer: Peer
  at: number
}

export interface Worker {
  /** Every pair the worker has been handed, in order. */
  seen: Peer[]
  /** The same, timestamped, for reasoning about who owned what and when. */
  handed: Handed[]
  peer: () => Peer
  stop: () => Promise<void>
}

export interface StartOptions {
  /** Wraps the Redis-backed registry, for fault injection. */
  wrap?: (registry: Registry) => Registry
  /** Runs inside the loop body, to model a consumer that takes its time. */
  onPeer?: (peer: Peer) => Promise<void> | void
}

/** Runs `discover` in the background on its own connection, recording what it yields. */
export const start = (
  options: Omit<DiscoverOptions, 'redis' | 'registry'>,
  { wrap, onPeer }: StartOptions = {}
): Worker => {
  const redis = connect()
  const seen: Peer[] = []
  const handed: Handed[] = []
  const control = new AbortController()

  const inner = redisRegistry(redis, {
    name: options.name,
    interval: options.interval,
    prefix: options.prefix,
  })

  let closing: Promise<void> | null = null

  const loop = (async () => {
    const peers = discover({
      ...options,
      registry: wrap ? wrap(inner) : inner,
      signal: options.signal ?? control.signal,
    })

    for await (const peer of peers) {
      // Timestamped before the consumer runs: this is the moment the worker
      // starts acting on the pair, which is what overlap is measured between.
      handed.push({ peer, at: Date.now() })
      seen.push(peer)
      await onPeer?.(peer)
    }
  })()

  return {
    seen,
    handed,
    peer: () => seen[seen.length - 1] ?? { i: null, n: null },
    stop() {
      // Tests stop a worker to model it leaving, and again on teardown.
      closing ??= (async () => {
        control.abort()
        await loop
        await redis.quit()
      })()

      return closing
    },
  }
}

/**
 * The whole point of the scheme: the live workers must hold `0..n-1`, each
 * exactly once. Anything else is a gap or a duplicate.
 */
export const assertCovers = (held: Peer[], n: number) => {
  const peers = held.filter((peer): peer is { i: number; n: number } => peer.i !== null)

  assert.equal(peers.length, n, `expected ${n} workers to own a slot, got ${peers.length}`)
  assert.deepEqual(
    peers.map(peer => peer.n),
    Array.from({ length: n }, () => n),
    'every worker must agree on n'
  )
  assert.deepEqual(
    peers.map(peer => peer.i).toSorted((a, b) => a - b),
    Array.from({ length: n }, (_, index) => index),
    'indices must cover 0..n-1 exactly once'
  )
}

export const assertPartitions = (workers: Worker[], n: number) =>
  assertCovers(
    workers.map(worker => worker.peer()),
    n
  )
