import { createConnection } from 'node:net'
import type { RedisLike } from '../src/index.ts'

/**
 * The least of a Redis client that compiles under scriptc: one connection,
 * `EVAL` and `EVALSHA`, and replies read as integers. ioredis and node-redis
 * cannot reach a server from a scriptc binary, so the native worker brings its
 * own.
 */
export interface Client {
  redis: RedisLike
  close: () => void
}

interface Reply {
  error: string | null
  values: number[]
}

interface Waiter {
  resolve: (values: number[]) => void
  reject: (error: Error) => void
}

const encode = (args: string[]): string =>
  `*${args.length}\r\n${args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`

/** One reply from `text` at `at`, and where it ends, or `null` while it is incomplete. */
const parse = (text: string, at: number): { reply: Reply; end: number } | null => {
  const eol = text.indexOf('\r\n', at)

  if (eol < 0) return null

  const kind = text[at]
  const line = text.slice(at + 1, eol)
  const next = eol + 2

  if (kind === '-') return { reply: { error: line, values: [] }, end: next }
  if (kind === ':') return { reply: { error: null, values: [Number(line)] }, end: next }

  if (kind === '*') {
    const values: number[] = []
    let end = next

    for (let index = 0; index < Number(line); index++) {
      const item = parse(text, end)

      if (item === null) return null

      const { reply, end: after } = item

      if (reply.error !== null) return item

      values.push(...reply.values)
      end = after
    }

    return { reply: { error: null, values }, end }
  }

  return { reply: { error: `unexpected reply ${line}`, values: [] }, end: next }
}

export const connect = (port: number, host: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(port, host)
    const waiters: Waiter[] = []
    // Replies are ASCII, so a chunk boundary never splits a character.
    let buffer = ''

    const send = async (args: string[]): Promise<unknown> => {
      const reply = Promise.withResolvers<number[]>()

      waiters.push({ resolve: reply.resolve, reject: reply.reject })
      socket.write(encode(args))

      const values = await reply.promise

      return values
    }

    const fail = (error: Error) => {
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    }

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')

      for (;;) {
        const item = parse(buffer, 0)

        if (item === null) break

        buffer = buffer.slice(item.end)

        const waiter = waiters.shift()

        if (waiter === undefined) continue

        if (item.reply.error === null) waiter.resolve(item.reply.values)
        else waiter.reject(new Error(item.reply.error))
      }
    })

    socket.on('error', (error: Error) => {
      fail(error)
      reject(error)
    })

    socket.on('close', () => fail(new Error('connection closed')))

    socket.on('connect', () =>
      resolve({
        redis: {
          eval: (script: string, keys: number, key: string, length: string, keep: string) =>
            send(['EVAL', script, String(keys), key, length, keep]),
          evalsha: (sha: string, keys: number, key: string, length: string, keep: string) =>
            send(['EVALSHA', sha, String(keys), key, length, keep]),
        },
        close: () => socket.end(),
      })
    )
  })
