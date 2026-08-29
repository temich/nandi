import assert from 'node:assert/strict'
import { Redis } from 'ioredis'
import { discover, type DiscoverOptions, type Peer } from './discover.ts'
import { redisRegistry, type Registry } from './registry.ts'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

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
  /** Every subsequent registration fails until {@link Fault.heal}. */
  fail: () => void
  heal: () => void
}

/** Wraps a real registry so a test can cut it off and restore it. */
export const faulty = (inner: Registry): Fault => {
  let broken = false

  return {
    registry: {
      register: () => (broken ? Promise.reject(new Error('injected outage')) : inner.register()),
    },
    fail: () => {
      broken = true
    },
    heal: () => {
      broken = false
    },
  }
}

export interface Worker {
  /** Every pair the worker has been handed, in order. */
  seen: Peer[]
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
  const control = new AbortController()

  const inner = redisRegistry(redis, {
    name: options.name,
    interval: options.interval,
    ttl: options.ttl ?? options.interval * 3,
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
      seen.push(peer)
      await onPeer?.(peer)
    }
  })()

  return {
    seen,
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
export const assertPartitions = (workers: Worker[], n: number) => {
  const peers = workers
    .map(worker => worker.peer())
    .filter((peer): peer is { i: number; n: number } => peer.i !== null)

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
