import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { assertPartitions, INTERVAL, group, settle, sleep, start, type Worker } from './harness.ts'

/** When a worker owned an index, as a half-open span of wall-clock time. */
interface Span {
  i: number
  from: number
  to: number
}

/**
 * Turns a worker's timestamped pairs into the spans it owned each index for.
 * The loop's final idle pass closes the last span, so a worker that is still
 * running has its span left open to now.
 */
const spans = (worker: Worker): Span[] => {
  const owned: Span[] = []

  for (const { peer, at } of worker.handed) {
    const last = owned[owned.length - 1]

    if (last && last.to === Infinity) last.to = at
    if (peer.i !== null) owned.push({ i: peer.i, from: at, to: Infinity })
  }

  return owned
}

const overlaps = (a: Span, b: Span) => a.from < b.to && b.from < a.to

describe('rebalance', () => {
  const running: Worker[] = []

  after(async () => {
    await Promise.all(running.map(worker => worker.stop()))
  })

  const spawn = (name: string) => {
    const worker = start({ name, interval: INTERVAL })
    running.push(worker)

    return worker
  }

  it('never lets two workers own the same index at once', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name), spawn(name), spawn(name)]

    await settle(() => assertPartitions(workers, 4), INTERVAL * 14)

    // A join and a departure, each of which moves every worker's n.
    const joiner = spawn(name)
    workers.push(joiner)
    await settle(() => assertPartitions(workers, 5), INTERVAL * 14)

    const leaving = workers.shift()!
    await leaving.stop()
    await settle(() => assertPartitions(workers, 4), INTERVAL * 14)

    const all = [leaving, ...workers].flatMap(worker =>
      spans(worker).map(span => ({ worker, span }))
    )

    for (let a = 0; a < all.length; a++)
      for (let b = a + 1; b < all.length; b++) {
        const [first, second] = [all[a]!, all[b]!]

        if (first.worker === second.worker) continue
        if (first.span.i !== second.span.i) continue

        assert.ok(
          !overlaps(first.span, second.span),
          `index ${first.span.i} held twice over ` +
            `[${first.span.from}, ${first.span.to}) and ` +
            `[${second.span.from}, ${second.span.to})`
        )
      }

    assert.ok(all.length > 8, `too few ownership changes to prove anything: ${all.length}`)
  })

  it('stands the group down together when a worker joins', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name), spawn(name)]

    await settle(() => assertPartitions(workers, 3), INTERVAL * 12)

    const before = workers.map(worker => worker.seen.length)
    workers.push(spawn(name))

    await settle(() => assertPartitions(workers, 4), INTERVAL * 14)

    // Every incumbent must have let go before taking up the new n, never
    // stepping straight from (i, 3) to (i, 4).
    for (const [index, worker] of workers.slice(0, 3).entries()) {
      const since = worker.seen.slice(before[index]!)
      const adopted = since.findIndex(peer => peer.n === 4)

      assert.ok(adopted >= 0, `worker ${index} never took up n = 4`)
      assert.deepEqual(
        since[adopted - 1],
        { i: null, n: null },
        `worker ${index} went straight to n = 4 without standing down`
      )
    }
  })

  it('keeps its phase across a rebalance, so the group settles back', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name), spawn(name)]

    await settle(() => assertPartitions(workers, 3), INTERVAL * 12)

    const before = workers.map(worker => worker.peer().i)

    // A join and an immediate departure: n leaves 3 and comes back to it.
    const passing = spawn(name)
    await settle(() => assertPartitions([...workers, passing], 4), INTERVAL * 14)
    await passing.stop()
    await settle(() => assertPartitions(workers, 3), INTERVAL * 14)
    await sleep(INTERVAL * 2)

    assert.deepEqual(
      workers.map(worker => worker.peer().i),
      before,
      'registration slots are kept while idle, so the same indices come back'
    )
  })
})
