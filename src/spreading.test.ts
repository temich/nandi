import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { assertPartitions, connect, group, settle, sleep, start, type Worker } from './harness.ts'
import type { Registry, Tick } from './registry.ts'

const INTERVAL = 300

interface Track {
  ticks: Tick[]
  wrap: (inner: Registry) => Registry
}

/** Records every registration a worker makes, so its timing can be inspected. */
const track = (): Track => {
  const ticks: Tick[] = []

  return {
    ticks,
    wrap: inner => ({
      register: async () => {
        const tick = await inner.register()
        ticks.push(tick)

        return tick
      },
    }),
  }
}

/** Where in its interval a registration landed, as a fraction. */
const at = (tick: Tick, interval: number) => (tick.at % interval) / interval

const owns = (worker: Worker) => worker.peer().i !== null

describe('spreading', () => {
  const running: Worker[] = []

  after(async () => {
    await Promise.all(running.map(worker => worker.stop()))
  })

  const spawn = (name: string, wrap?: (inner: Registry) => Registry) => {
    const worker = start({ name, interval: INTERVAL }, { wrap })
    running.push(worker)

    return worker
  }

  it('leaves a settled group alone', async () => {
    const name = group()
    const workers = Array.from({ length: 5 }, () => spawn(name))

    await settle(() => assertPartitions(workers, workers.length), INTERVAL * 20)

    // Convergence itself yields; the claim is about what happens afterwards.
    await sleep(INTERVAL * 2)

    const settled = workers.map(worker => worker.seen.length)
    const mapping = workers.map(worker => `${worker.peer().i}/${worker.peer().n}`)

    await sleep(INTERVAL * 8)

    assert.deepEqual(
      workers.map(worker => worker.seen.length),
      settled,
      'a stable group must not be handed a new pair'
    )
    assert.deepEqual(
      workers.map(worker => `${worker.peer().i}/${worker.peer().n}`),
      mapping
    )
  })

  it('spreads registrations across the interval', async () => {
    const name = group()
    const tracks = Array.from({ length: 4 }, () => track())
    const workers = tracks.map(({ wrap }) => spawn(name, wrap))

    await settle(() => assert.ok(workers.every(worker => owns(worker))), INTERVAL * 12)
    await sleep(INTERVAL * 4)

    const phases = tracks.map(({ ticks }) => at(ticks.at(-1)!, INTERVAL)).toSorted((a, b) => a - b)

    for (let index = 1; index < phases.length; index++) {
      const gap = phases[index]! - phases[index - 1]!

      assert.ok(gap > 0.1, `workers bunched together at ${phases.join(', ')}`)
    }
  })

  it('registers at most once per interval', async () => {
    const name = group()
    const tracks = Array.from({ length: 3 }, () => track())
    const workers = tracks.map(({ wrap }) => spawn(name, wrap))

    await settle(() => assert.ok(workers.every(worker => owns(worker))), INTERVAL * 12)
    await sleep(INTERVAL * 6)

    for (const { ticks } of tracks) {
      const intervals = ticks.map(tick => tick.interval)

      for (let index = 1; index < intervals.length; index++)
        assert.ok(
          intervals[index]! > intervals[index - 1]!,
          `registered twice in one interval: ${intervals.join(', ')}`
        )
    }
  })

  it('puts workers on different phases in the same interval key', async () => {
    const name = group()
    const redis = connect()

    try {
      spawn(name)
      await sleep(INTERVAL * 1.5)
      spawn(name)

      // Server-derived intervals, so a worker half a cycle behind still counts
      // into the same key rather than one of its own.
      await settle(async () => {
        const keys = await redis.keys(`{${name}}:*`)
        const counts = await Promise.all(keys.map(key => redis.get(key)))

        assert.ok(
          counts.some(count => count === '2'),
          `no shared interval in ${counts.join(', ')}`
        )
      }, INTERVAL * 12)
    } finally {
      await redis.quit()
    }
  })
})
