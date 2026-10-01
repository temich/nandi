import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import type { Peer } from '../src/index.ts'
import { assertCovers, connect, group, INTERVAL, REDIS_URL, settle } from '../src/harness.ts'

const run = promisify(execFile)
const here = import.meta.dirname
const scriptc = join(here, 'node_modules', '.bin', 'scriptc')

interface Native {
  peer: () => Peer
  stderr: () => string
  process: ChildProcess
}

describe('a native worker', () => {
  let directory = ''
  let binary = ''
  const workers: Native[] = []

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nandi-native-'))
    binary = join(directory, 'worker')

    await run(scriptc, ['build', join(here, 'worker.ts'), '-o', binary], { cwd: here })
  })

  after(async () => {
    for (const worker of workers) worker.process.kill('SIGKILL')

    await rm(directory, { recursive: true, force: true })
  })

  const launch = (name: string): Native => {
    const { hostname, port } = new URL(REDIS_URL)
    const child = spawn(binary, [hostname, port || '6379', name, String(INTERVAL)])
    let peer: Peer = { i: null, n: null }
    let out = ''
    let err = ''

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk

      const lines = out.split('\n')

      out = lines.pop() ?? ''

      for (const line of lines) peer = JSON.parse(line) as Peer
    })

    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk
    })

    const worker = { peer: () => peer, stderr: () => err, process: child }

    workers.push(worker)

    return worker
  }

  it('partitions a group through Redis', async () => {
    // A server that has never seen the script makes the first registration
    // take the NOSCRIPT path as well.
    const redis = connect()

    await redis.script('FLUSH')
    await redis.quit()

    const name = group()
    const group3 = [launch(name), launch(name), launch(name)]

    await settle(() => {
      assert.equal(group3.map(worker => worker.stderr()).join(''), '')
      assertCovers(
        group3.map(worker => worker.peer()),
        3
      )
    }, INTERVAL * 20)
  })
})
