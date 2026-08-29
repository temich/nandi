import { Redis } from 'ioredis'
import { discover, type DiscoverOptions, type Peer } from './discover.ts'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export const connect = () => new Redis(REDIS_URL)

let seq = 0

/** A group name no other test shares, so suites can run against one Redis. */
export const group = () => `nandi-test-${process.pid}-${++seq}`

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

export interface Worker {
  /** Every pair the worker has been handed, in order. */
  seen: Peer[]
  peer: () => Peer
  stop: () => Promise<void>
}

/** Runs `discover` in the background on its own connection, recording what it yields. */
export const start = (options: Omit<DiscoverOptions, 'redis' | 'registry'>): Worker => {
  const redis = connect()
  const seen: Peer[] = []

  const loop = (async () => {
    try {
      for await (const peer of discover({ redis, ...options })) seen.push(peer)
    } catch {
      // Stopping a worker severs its connection; the loop ending is the point.
    }
  })()

  return {
    seen,
    peer: () => seen[seen.length - 1] ?? { i: null, n: null },
    async stop() {
      redis.disconnect()
      await loop
    },
  }
}
