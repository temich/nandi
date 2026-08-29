import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { connect, faulty, INTERVAL, group, settle, sleep, start, type Worker } from './harness.ts'
import { discover, type Peer } from './discover.ts'
import { redisRegistry } from './registry.ts'

const owns = (peer: Peer) => peer.i !== null

/** The highest interval a group has registered in — monotonic while it runs. */
const reached = async (name: string) => {
  const redis = connect()

  try {
    const keys = await redis.keys(`{${name}}:*`)

    return keys.length === 0 ? 0 : Math.max(...keys.map(key => Number(key.split(':').pop())))
  } finally {
    await redis.quit()
  }
}

describe('lifecycle', () => {
  const running: Worker[] = []
  const connections: ReturnType<typeof connect>[] = []

  after(async () => {
    await Promise.all(running.map(worker => worker.stop()))
    await Promise.all(connections.map(redis => redis.quit()))
  })

  it('goes idle when registration is lost, and rejoins when it returns', async () => {
    const name = group()
    const redis = connect()
    connections.push(redis)

    const outage = faulty(redisRegistry(redis, { name, interval: INTERVAL }))
    const worker = start({ name, interval: INTERVAL }, { wrap: () => outage.registry })
    running.push(worker)

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 6)

    outage.fail()
    await settle(() => assert.ok(!owns(worker.peer()), 'must stop consuming'), INTERVAL * 6)

    outage.heal()
    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 }), INTERVAL * 8)
  })

  it('never hands out the same pair twice in a row', async () => {
    const name = group()
    const workers = [start({ name, interval: INTERVAL }), start({ name, interval: INTERVAL })]
    running.push(...workers)

    await settle(() => assert.ok(workers.every(worker => owns(worker.peer()))), INTERVAL * 8)
    await sleep(INTERVAL * 3)

    for (const worker of workers) {
      const pairs = worker.seen.map(peer => `${peer.i}/${peer.n}`)

      for (let index = 1; index < pairs.length; index++)
        assert.notEqual(pairs[index], pairs[index - 1], `repeated ${pairs[index]}`)
    }
  })

  it('keeps registering while the consumer is busy', async () => {
    const name = group()
    const worker = start(
      { name, interval: INTERVAL },
      { onPeer: peer => (owns(peer) ? sleep(INTERVAL * 4) : undefined) }
    )
    running.push(worker)

    await settle(() => assert.ok(owns(worker.peer())), INTERVAL * 6)

    // The consumer is now blocked for four intervals; registration must not be.
    const before = await reached(name)
    await sleep(INTERVAL * 3)
    const later = await reached(name)

    assert.ok(later >= before + 2, `registration stalled: ${before} → ${later}`)
  })

  it('stops registering once the loop is broken out of', async () => {
    const name = group()
    const redis = connect()

    for await (const peer of discover({ redis, name, interval: INTERVAL })) if (owns(peer)) break

    const stopped = await reached(name)
    await sleep(INTERVAL * 3)

    assert.ok((await reached(name)) <= stopped, 'registration continued after break')

    await redis.quit()
  })

  it('hands the body a final idle pass when the signal aborts', async () => {
    const name = group()
    const redis = connect()
    const control = new AbortController()
    const seen: Peer[] = []

    for await (const peer of discover({
      redis,
      name,
      interval: INTERVAL,
      signal: control.signal,
    })) {
      seen.push(peer)

      if (owns(peer)) control.abort()
    }

    assert.ok(
      seen.some(peer => owns(peer)),
      'never owned a slot to stand down from'
    )
    assert.deepEqual(seen.at(-1), { i: null, n: null }, 'must end the loop owning nothing')

    await redis.quit()
  })

  it('does not repeat the idle pair when it owned nothing', async () => {
    const name = group()
    const redis = connect()
    const control = new AbortController()
    const seen: Peer[] = []

    const loop = (async () => {
      const found = discover({ redis, name, interval: INTERVAL, signal: control.signal })

      for await (const peer of found) seen.push(peer)
    })()

    // Long enough for the opening idle, far short of owning anything.
    await sleep(INTERVAL / 4)
    control.abort()
    await loop

    assert.deepEqual(seen, [{ i: null, n: null }])

    await redis.quit()
  })

  it('stops registering once the signal aborts', async () => {
    const name = group()
    const redis = connect()
    const control = new AbortController()

    const loop = (async () => {
      for await (const peer of discover({
        redis,
        name,
        interval: INTERVAL,
        signal: control.signal,
      }))
        if (owns(peer)) control.abort()
    })()

    await loop

    const stopped = await reached(name)
    await sleep(INTERVAL * 3)

    assert.ok((await reached(name)) <= stopped, 'registration continued after abort')

    await redis.quit()
  })
})
