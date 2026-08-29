import { createHash } from 'node:crypto'
import { REGISTER } from './lua.ts'

/** One registration: what the group looked like, as of one call. */
export interface Tick {
  /** The interval the caller has just registered in, from the server clock. */
  interval: number
  /** The caller's own 0-based index within that interval. */
  index: number
  /** How many registered in the previous interval, or `null` if it is gone. */
  replicas: number | null
  /** The server's clock, in milliseconds, at the moment of the call. */
  at: number
}

/**
 * The one operation `discover` needs: register me, and tell me what the
 * previous interval came to. Implemented over Redis below; anything else that
 * can honour the contract may be passed in its place.
 */
export interface Registry {
  register(): Promise<Tick>
}

/** How ioredis takes a script: the key count, then keys, then arguments. */
interface Ioredis {
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>
  evalsha(sha: string, keys: number, ...args: string[]): Promise<unknown>
}

/** How node-redis takes a script: keys and arguments as named lists. */
interface NodeRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Either client will do; the two call shapes are normalised below. */
export type RedisLike = Ioredis | NodeRedis

export interface RedisRegistryOptions {
  /** Worker group name, for example `mail-sender`. */
  name: string
  /** Interval length in milliseconds. */
  interval: number
  /** Prepended to the key, for namespacing. */
  prefix?: string
}

/**
 * Keys are written as `{name}:N`. The braces are a Redis hash tag, so every
 * interval key of a group lands in one slot and the two keys the script touches
 * are never cross-slot.
 */
export const base = ({ name, prefix = '' }: RedisRegistryOptions): string => `${prefix}{${name}}`

/**
 * Intervals an interval key is kept for. It only has to outlive the one
 * interval that reads it; the rest is room for a worker that fell behind.
 */
const KEEP = 3

const SHA = createHash('sha1').update(REGISTER).digest('hex')

const isNodeRedis = (redis: RedisLike): redis is NodeRedis => 'evalSha' in redis

/** Redis reports an unknown script by name; anything else is a real failure. */
const isMissingScript = (error: unknown) =>
  error instanceof Error && error.message.includes('NOSCRIPT')

export const redisRegistry = (redis: RedisLike, options: RedisRegistryOptions): Registry => {
  const key = base(options)
  const argv = [String(options.interval), String(options.interval * KEEP)]

  const byHash = isNodeRedis(redis)
    ? () => redis.evalSha(SHA, { keys: [key], arguments: argv })
    : () => redis.evalsha(SHA, 1, key, ...argv)

  const bySource = isNodeRedis(redis)
    ? () => redis.eval(REGISTER, { keys: [key], arguments: argv })
    : () => redis.eval(REGISTER, 1, key, ...argv)

  /** Send the hash, and only ship the source when the server has not seen it. */
  const call = async () => {
    try {
      return await byHash()
    } catch (error) {
      if (!isMissingScript(error)) throw error

      return await bySource()
    }
  }

  return {
    async register() {
      const reply = await call()

      if (!Array.isArray(reply) || reply.length !== 4)
        throw new TypeError(`n-and-i: unexpected registration reply ${JSON.stringify(reply)}`)

      const [interval, raw, previous, at] = reply.map(Number)

      return {
        interval: interval!,
        index: raw! - 1,
        replicas: previous! < 0 ? null : previous!,
        at: at!,
      }
    },
  }
}
