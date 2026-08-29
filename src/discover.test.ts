import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { assertPartitions, connect, group, settle, sleep, start, type Worker } from './harness.ts'
import type { Peer } from './discover.ts'

const INTERVAL = 300

describe('discover', () => {
  const running: Worker[] = []

  const spawn = (name: string) => {
    const worker = start({ name, interval: INTERVAL })
    running.push(worker)
    return worker
  }

  after(async () => {
    await Promise.all(running.map(worker => worker.stop()))
  })

  it('yields idle before anything is known', async () => {
    const worker = spawn(group())

    await settle(() => assert.ok(worker.seen.length > 0))
    assert.deepEqual(worker.seen[0], { i: null, n: null } satisfies Peer)
  })

  it('settles a lone worker on (0, 1)', async () => {
    const worker = spawn(group())

    await settle(() => assert.deepEqual(worker.peer(), { i: 0, n: 1 } satisfies Peer), INTERVAL * 6)
  })

  it('partitions a group of three across 0..2', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name), spawn(name)]

    await settle(() => assertPartitions(workers, 3), INTERVAL * 8)
  })

  it('holds a new worker idle for a full interval, then takes it in', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name), spawn(name)]

    await settle(() => assertPartitions(workers, 3), INTERVAL * 8)

    const joiner = spawn(name)
    workers.push(joiner)

    // It registers straight away, but has no index from a closed interval yet.
    await sleep(INTERVAL * 0.75)
    assert.deepEqual(joiner.peer(), { i: null, n: null } satisfies Peer)

    await settle(() => assertPartitions(workers, 4), INTERVAL * 8)
  })

  it('closes the gap when a worker leaves', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name), spawn(name), spawn(name)]

    await settle(() => assertPartitions(workers, 4), INTERVAL * 10)

    const leaving = workers.pop()!
    await leaving.stop()

    await settle(() => assertPartitions(workers, 3), INTERVAL * 10)
  })

  it('expires interval keys', async () => {
    const name = group()
    const redis = connect()
    spawn(name)

    try {
      await settle(
        async () => assert.ok((await redis.keys(`{${name}}:*`)).length > 0),
        INTERVAL * 4
      )

      const [key] = await redis.keys(`{${name}}:*`)
      const ttl = await redis.pttl(key!)

      // Default ttl is three intervals; it is counting down from there.
      assert.ok(ttl > 0 && ttl <= INTERVAL * 3, `unexpected ttl ${ttl}`)

      // Nothing older than the ttl survives, however long the group runs.
      await sleep(INTERVAL * 5)
      assert.ok((await redis.keys(`{${name}}:*`)).length <= 4)
    } finally {
      await redis.quit()
    }
  })
})
