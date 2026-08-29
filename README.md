# n-and-i

Distributed peer indexing with Redis.

Workers that split a shared task source by `task.id % n === i` need two numbers:
`n`, how many of them are live, and `i`, which one this process is. This derives
both from Redis, with no coordinator — workers register themselves in a counter
keyed by the current time interval, and the count that interval closed on
becomes the replica count.

Based on [Distributed Peer Indexing](https://temich.net/notes/peers/).

## Usage

```sh
npm install n-and-i
```

```ts
import { discover } from 'n-and-i'

for await (const { i, n } of discover({ redis, name: 'mail-sender', interval: 30_000 })) {
  await drain() // stop taking new work, finish or release what is in flight

  if (i === null) continue // not registered — stay stopped

  run(task => task.id % n === i)
}
```

The loop yields only when ownership changes, so its body is exactly the point at
which to hand work over: stop consuming, drain, adopt the new pair, resume. A
settled group yields once and then stays quiet for as long as its membership
holds.

`redis` is an [ioredis](https://github.com/redis/ioredis) or
[node-redis](https://github.com/redis/node-redis) client — whichever you already
have. Nothing else is a dependency.

### Shutting down

Aborting the signal yields the idle pair one last time before the loop finishes,
so a worker stands down inside the loop body — the same place it already handles
losing its registration:

```ts
const control = new AbortController()
process.on('SIGTERM', () => control.abort())

const peers = discover({
  redis,
  name: 'mail-sender',
  interval: 30_000,
  signal: control.signal,
})

for await (const { i, n } of peers) {
  await drain()

  if (i === null) continue

  consume(task => task.id % n === i)
}

// the loop never ends while the worker still owns a slot
await redis.quit()
```

Leaving with `break` is immediate instead — a generator cannot yield once the
consumer has left — so draining from there is your own.

Either way the worker stays counted in the interval it last registered in, so
its slot goes unowned for up to one interval after it leaves, exactly as if it
had crashed.

### Options

| Option     |                |                                                            |
| ---------- | -------------- | ---------------------------------------------------------- |
| `redis`    | required\*     | An ioredis or node-redis client.                           |
| `name`     | required       | Worker group name, for example `mail-sender`.              |
| `interval` | required       | Interval length in milliseconds.                           |
| `ttl`      | `interval * 3` | How long interval keys live.                               |
| `prefix`   | `''`           | Prepended to the key, for namespacing.                     |
| `signal`   |                | An `AbortSignal`; aborting ends the loop, as `break` does. |
| `registry` |                | A registry of your own, in place of `redis`.               |

\* Either `redis` or `registry`.

### Choosing an interval

Ten to thirty seconds suits most groups. The interval has to comfortably exceed
a registration round trip and the jitter around it, and it also sets the pace of
everything else: a new worker waits one interval before it owns anything, and a
departure is noticed one interval after it happens.

Short intervals react faster but spend a larger share of themselves in transit,
and leave less room between workers. Long intervals are calmer but slower to
reflect reality. Nothing below a second is sensible in production, though the
library enforces no floor — its own tests run at 300ms.

## How it works

Each worker `INCR`s a key naming the current interval. The reply is its index
for that interval; the value the previous key closed on is the replica count.
Redis holds nothing but counters — no membership list, no identities:

```
{mail-sender}:58391 = 3      <- closed, so its count is final
{mail-sender}:58392 = 3      <- open, still accepting registrations
```

The interval number comes from `TIME` inside the script, so every worker agrees
on it by construction and clock differences between workers do not come into it.

**Both numbers come from the same closed interval.** A worker keeps the index it
received last time in memory and pairs it with that interval's final count. The
registrants of `N-1` therefore hold exactly `0..n-1`, each once — a complete
partition with no overlap. Pairing an index from the open interval with a count
from the closed one is what would let a worker claim a slot in a group it was
not part of.

That also settles what happens to a worker that has just started: it has no
index from a closed interval, so it has nothing to pair, and it owns nothing
until the interval it registered in has closed. The same check covers a worker
that stalled past an interval or restarted — the absence of a usable index is
what makes it wait, and no identity or registry of members is needed to detect
it.

### Registration timing

Workers do not all register at the same moment. Each fires at `(i + 0.5) / n` of
the interval, worked out from the values its previous call returned and kept
clear of the boundaries. Ordering then stops depending on network jitter, and
the arrangement is self-reinforcing: a worker holding index 2 of 5 fires third
and is handed index 2 again.

A settled group keeps its assignment indefinitely. A join shifts only the
workers after the insertion point; a departure shifts only those after the gap.
Two workers that do collide are handed different indices and separate on the
next interval.

## What this does not give you

**Ownership is eventual.** The pair in force describes the previous interval, so
membership changes take one to two intervals to show up. This suits groups that
tolerate controlled rebalancing; it is not a substitute for a real coordination
protocol when ownership must change immediately and consistently.

**Rebalances have a window.** Each worker adopts a new pair when its own
registration returns, not at a shared instant, so for a fraction of an interval
during a rebalance two mappings are live across the group and a task that
changed hands can be picked up twice. Consumers that need at-most-once have to
fence the work itself.

**A worker that registers and then dies leaves its slot unowned** until the next
interval, because the count is a snapshot of who _was_ present. No membership
scheme avoids this; only a shorter interval narrows it.

**Registration failures are silent.** A blip is retried within the interval, and
a full interval with no successful registration hands the loop the idle pair
rather than raising. A worker Redis has stopped counting stops consuming.

## Redis Cluster

Keys are written as `{name}:N`. The braces are a hash tag, so every interval key
of a group lands in one slot and the two keys the script touches are never
cross-slot.

## Development

The tests are integration tests: they need a Redis, and fail without one.

```sh
docker run --rm -p 6379:6379 redis:8-alpine

npm install
npm run check   # typecheck + lint + format check + tests
npm run build   # emits dist/
```

`REDIS_URL` points them elsewhere (default `redis://localhost:6379`), and
`TEST_INTERVAL` sets the interval they run at in milliseconds (default `300`).
A slower machine wants a larger one — CI uses `600`.

| script              | does                                   |
| ------------------- | -------------------------------------- |
| `npm run typecheck` | `tsc --noEmit`                         |
| `npm run lint`      | `oxlint .` (`lint:fix` to autofix)     |
| `npm run fmt`       | `oxfmt .` (`fmt:check` in CI)          |
| `npm test`          | `node --test` over `src/**/*.test.ts`  |
| `npm run build`     | `tsc -p tsconfig.build.json` → `dist/` |

`husky` runs `npm run check` on pre-commit and lints the message against
[conventional commits](https://www.conventionalcommits.org) on commit-msg.

## Branches and releases

- `dev` — the default branch. Changes land here through a pull request that
  passes `ci` and carries an approving review.
- `release` — merging `dev` into it runs `semantic-release`, which derives the
  version from the commit messages, tags it, publishes the package to npm, and
  cuts a GitHub Release with the generated notes.

Commit messages are the release input, so `commit-msg` lints them against
[conventional commits](https://www.conventionalcommits.org). The version in this
repository's `package.json` is not bumped by the release — the git tags are the
record, and `semantic-release` sets the published version at publish time.

Publishing to npm authenticates over OIDC — npm trusted publishing, configured
against this repository and `release.yml`. No `NPM_TOKEN` secret is involved:
the workflow requests `id-token: write` and npm (>= 11.5.1, which Node 24
bundles) exchanges that for a short-lived credential, and stamps the release
with a provenance attestation.

The trust relationship itself is registry-side state, not repository state:

```sh
npm trust list n-and-i
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and release procedure,
and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## License

[MIT](LICENSE) © Artem Gurtovoi
