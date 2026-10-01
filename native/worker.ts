import { discover, type Console } from '../src/index.ts'
import { connect } from './resp.ts'

/**
 * A worker as a scriptc binary: `worker <host> <port> <name> <interval>`.
 * Writes every pair it is handed to stdout as a JSON line, and anything the
 * library raises to stderr. Runs until killed.
 */
const [host = 'localhost', port = '6379', name = 'native', interval = '300'] = process.argv.slice(2)

const quiet = () => {}

const raise = (message: string, attributes: Record<string, unknown>) => {
  process.stderr.write(`${message} ${JSON.stringify(attributes)}\n`)
}

const console: Console = { trace: quiet, debug: quiet, info: quiet, warn: raise, error: raise }

const client = await connect(Number(port), host)

for await (const peer of discover({
  redis: client.redis,
  name,
  interval: Number(interval),
  console,
}))
  process.stdout.write(`${JSON.stringify(peer)}\n`)
