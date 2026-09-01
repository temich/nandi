import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { Console } from './console.ts'
import { connect, faulty, INTERVAL, group, settle, start, type Fault } from './harness.ts'
import { discover, type Peer } from './discover.ts'
import { redisRegistry } from './registry.ts'

const owns = (peer: Peer) => peer.i !== null

/** Every message the library is allowed to write. */
const MESSAGES = new Set([
  'discover started',
  'discover stopped',
  'lease granted',
  'lease released',
  'lease expired',
  'registration completed',
  'registration failed',
  'script loaded',
  'pair agreed',
  'pair disagreed',
  'no pair implied',
  'next registration scheduled',
  'pair handed to the loop',
])

interface Line {
  level: keyof Console
  message: string
  attributes: Record<string, unknown>
}

/** A console that does the worst thing a console can do. */
const angry = () => {
  throw new Error('console is broken')
}

/** A console that keeps what it was told, for the assertions to read back. */
const recorder = () => {
  const lines: Line[] = []

  const push = (level: keyof Console) => (message: string, attributes: Record<string, unknown>) => {
    lines.push({ level, message, attributes })
  }

  return {
    lines,
    console: {
      trace: push('trace'),
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    } satisfies Console,
    /** Every line carrying a given message. */
    at: (message: string) => lines.filter(line => line.message === message),
    /** Everything the library considers a problem. */
    raised: () => lines.filter(line => line.level === 'warn' || line.level === 'error'),
  }
}

describe('console', () => {
  const faults: Fault[] = []
  const connections: ReturnType<typeof connect>[] = []

  const injected = (name: string, redis: ReturnType<typeof connect>) => {
    const outage = faulty(redisRegistry(redis, { name, interval: INTERVAL }))
    faults.push(outage)

    return outage
  }

  after(async () => {
    for (const outage of faults) outage.heal()

    await Promise.all(connections.map(redis => redis.quit()))
  })

  it('reports a worker taking up its pair', async () => {
    const name = group()
    const log = recorder()
    const worker = start({ name, interval: INTERVAL, console: log.console })

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)
    await worker.stop()

    assert.deepEqual(log.at('discover started')[0]?.attributes, {
      name,
      interval: INTERVAL,
      gap: 0.15,
      prefix: '',
      registry: 'custom',
    })

    assert.ok(log.at('registration completed').length >= 3, 'must report every registration')
    assert.deepEqual(log.at('lease granted')[0]?.attributes, { name, i: 0, n: 1 })

    // The pair is only handed over once the interval before it agreed, so the
    // disagreement that precedes it is on the record too.
    assert.equal(log.at('pair disagreed').length, 1)
    assert.equal(
      log.at('pair disagreed')[0]?.level,
      'debug',
      'the one interval that held the pair back must not sit at the level its agreeing counterpart repeats at'
    )
    assert.ok(log.at('pair agreed').some(line => line.attributes.i === 0))

    assert.equal(
      log.at('pair handed to the loop').length,
      worker.seen.length,
      'every pair the body was handed must be on the record, the opening idle included'
    )

    for (const line of log.lines) assert.equal(line.attributes.name, name, line.message)
  })

  it('says nothing above info while nothing is wrong', async () => {
    const name = group()
    const log = recorder()
    const worker = start({ name, interval: INTERVAL, console: log.console })

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)
    await worker.stop()

    assert.deepEqual(
      log.raised().map(line => `${line.level} ${line.message}`),
      [],
      'a healthy group must not rise above info'
    )

    // Start, take up a pair, give it back, end: the whole run at info level.
    assert.deepEqual(
      log.lines.filter(line => line.level === 'info').map(line => line.message),
      ['discover started', 'lease granted', 'lease released', 'discover stopped']
    )
  })

  it('writes only constant messages', async () => {
    const name = group()
    const log = recorder()
    const redis = connect()
    connections.push(redis)

    const outage = injected(name, redis)
    const worker = start(
      { name, interval: INTERVAL, console: log.console },
      { wrap: () => outage.registry }
    )

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)

    outage.fail()
    await settle(() => assert.ok(!owns(worker.peer())), INTERVAL * 6)

    outage.heal()
    await worker.stop()

    for (const line of log.lines)
      assert.ok(MESSAGES.has(line.message), `interpolated message: ${line.message}`)
  })

  it('reports a registration that failed, with the error it swallowed', async () => {
    const name = group()
    const log = recorder()
    const redis = connect()
    connections.push(redis)

    const outage = injected(name, redis)
    const worker = start(
      { name, interval: INTERVAL, console: log.console },
      { wrap: () => outage.registry }
    )

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)

    outage.fail()
    await settle(() => assert.ok(log.at('registration failed').length >= 2), INTERVAL * 6)

    const failures = log.at('registration failed')
    const [first] = failures

    assert.ok(first, 'the swallowed error must be reported')
    assert.ok(failures.every(line => line.level === 'error'))
    assert.match(String((first.attributes.error as Error).message), /injected outage/)
    assert.deepEqual(
      failures.slice(0, 2).map(line => line.attributes.attempt),
      [1, 2],
      'the attempt must count up while the outage lasts'
    )
    assert.ok(typeof first.attributes.delay === 'number')

    outage.heal()
    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 10)
    await worker.stop()
  })

  it('reports the lease expiring when a registration never comes back', async () => {
    const name = group()
    const log = recorder()
    const redis = connect()
    connections.push(redis)

    const outage = injected(name, redis)
    const worker = start(
      { name, interval: INTERVAL, console: log.console },
      { wrap: () => outage.registry }
    )

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)

    // Nothing throws, so the error path never sees it: only the stand-down
    // timer notices, and it is the one thing that warns.
    outage.stall()
    await settle(() => assert.ok(!owns(worker.peer())), INTERVAL * 6)

    const expired = log.lines.findIndex(line => line.message === 'lease expired')

    assert.ok(expired >= 0, 'the stand-down must be reported')
    assert.equal(log.lines[expired]?.level, 'warn')
    assert.equal(log.at('registration failed').length, 0, 'nothing was on the error path')
    assert.ok(typeof log.lines[expired]?.attributes.after === 'number')
    assert.ok(
      log.lines.slice(expired).some(line => line.message === 'lease released'),
      'the expiry must be followed by the pair being given back'
    )

    outage.heal()
    await worker.stop()
  })

  it('says why the loop ended', async () => {
    const aborted = recorder()
    const worker = start({ name: group(), interval: INTERVAL, console: aborted.console })

    await settle(() => assert.ok(owns(worker.peer())), INTERVAL * 8)
    await worker.stop()

    assert.deepEqual(aborted.at('discover stopped')[0]?.attributes.reason, 'abort')
    assert.equal(
      aborted.lines.at(-1)?.message,
      'discover stopped',
      'the last line must be the loop ending'
    )

    const closed = recorder()
    const redis = connect()
    const name = group()

    for await (const peer of discover({ redis, name, interval: INTERVAL, console: closed.console }))
      if (owns(peer)) break

    assert.deepEqual(closed.at('discover stopped')[0]?.attributes.reason, 'closed')

    await redis.quit()
  })

  it('reports the script being shipped to a server that has not seen it', async () => {
    const name = group()
    const log = recorder()
    const redis = connect()
    const control = new AbortController()

    await redis.script('FLUSH')

    for await (const peer of discover({
      redis,
      name,
      interval: INTERVAL,
      console: log.console,
      signal: control.signal,
    }))
      if (owns(peer)) control.abort()

    const loaded = log.at('script loaded')

    assert.equal(loaded.length, 1, 'the source is shipped once, not every call')
    assert.equal(loaded[0]?.level, 'debug')
    assert.match(String(loaded[0]?.attributes.sha), /^[0-9a-f]{40}$/)
    assert.equal(log.at('discover started')[0]?.attributes.registry, 'redis')

    await redis.quit()
  })

  it('carries on when the console throws', async () => {
    const name = group()
    const worker = start({
      name,
      interval: INTERVAL,
      console: { trace: angry, debug: angry, info: angry, warn: angry, error: angry },
    })

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)
    await worker.stop()
  })
})
