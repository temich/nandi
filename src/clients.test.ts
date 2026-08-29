import { describe, it } from 'node:test'
import { Redis } from 'ioredis'
import { createClient } from 'redis'
import { assertCovers, group, REDIS_URL, settle } from './harness.ts'
import { discover, type Peer } from './discover.ts'
import type { RedisLike } from './registry.ts'

const INTERVAL = 300
const IDLE: Peer = { i: null, n: null }

interface Client {
  redis: RedisLike
  close: () => Promise<void>
}

/** The two clients that cover almost all of Node, with their differing call shapes. */
const clients: { name: string; open: () => Promise<Client> }[] = [
  {
    name: 'ioredis',
    open: async () => {
      const redis = new Redis(REDIS_URL)

      return {
        redis,
        close: async () => {
          await redis.quit()
        },
      }
    },
  },
  {
    name: 'node-redis',
    open: async () => {
      const redis = createClient({ url: REDIS_URL })
      await redis.connect()

      return {
        redis,
        close: async () => {
          await redis.close()
        },
      }
    },
  },
]

describe('clients', () => {
  for (const { name: client, open } of clients)
    it(`partitions a group over ${client}`, async () => {
      const name = group()
      const size = 3
      const peers: Peer[] = Array.from({ length: size }, () => IDLE)
      const control = new AbortController()
      const opened = await Promise.all(Array.from({ length: size }, () => open()))

      const loops = opened.map(({ redis }, index) =>
        (async () => {
          const found = discover({ redis, name, interval: INTERVAL, signal: control.signal })

          for await (const peer of found) peers[index] = peer
        })()
      )

      try {
        await settle(() => assertCovers(peers, size), INTERVAL * 20)
      } finally {
        control.abort()
        await Promise.all(loops)
        await Promise.all(opened.map(({ close }) => close()))
      }
    })
})
