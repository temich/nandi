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

/** The subset of ioredis and node-redis that {@link redisRegistry} calls. */
export interface RedisLike {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>
}

export interface RedisRegistryOptions {
  /** Worker group name, for example `mail-sender`. */
  name: string
  /** Interval length in milliseconds. */
  interval: number
  /** How long interval keys live, in milliseconds. */
  ttl: number
  /** Prepended to the key, for namespacing. */
  prefix?: string
}

/**
 * Keys are written as `{name}:N`. The braces are a Redis hash tag, so every
 * interval key of a group lands in one slot and the two keys the script touches
 * are never cross-slot.
 */
export const base = ({ name, prefix = '' }: RedisRegistryOptions): string => `${prefix}{${name}}`

export const redisRegistry = (redis: RedisLike, options: RedisRegistryOptions): Registry => {
  const key = base(options)
  const argv = [String(options.interval), String(options.ttl)]

  return {
    async register() {
      const reply = await redis.eval(REGISTER, 1, key, ...argv)

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
