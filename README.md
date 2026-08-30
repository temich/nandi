# Distributed peer indexing with Redis

Workers that split a shared task source by `task.id % n === i` need two numbers.
[Read more](https://temich.net/notes/peers/)

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

What it hands you is an exclusive lease. Two consecutive intervals have to agree
on a pair before it reaches the loop, and it then runs for `interval + gap`,
renewed by every registration that agrees again. Exclusive is meant literally:
while you hold `i`, no other worker in the group holds it. When a registration
does not arrive — the server is gone, slow, or answering nothing at all — the
lease runs out and the loop hands you the idle pair instead. Nothing outside the
worker revokes it, so there is never anything to wait for.

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

| Option     |            |                                                            |
| ---------- | ---------- | ---------------------------------------------------------- |
| `redis`    | required   | An ioredis or node-redis client.                           |
| `name`     | required   | Worker group name, for example `mail-sender`.              |
| `interval` | required\* | Interval length in milliseconds.                           |
| `gap`      | `0.15`     | Timing slack, as a fraction of the interval.               |
| `prefix`   | `''`       | Prepended to the key, for namespacing.                     |
| `signal`   |            | An `AbortSignal`; aborting ends the loop, as `break` does. |

\* A worker owns nothing until two consecutive closed intervals have agreed on
its pair, so it starts consuming **no earlier than** two intervals after it
comes up.

### Choosing an interval

Ten to thirty seconds suits most groups. The interval has to comfortably exceed
a registration round trip and the jitter around it, and it also sets the pace of
everything else: a new worker waits two intervals before it owns anything, and a
departure costs the group about one interval of standing down.

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

**And the pair has to hold for two intervals running.** Each worker adopts its
new pair when its own registration returns, not at a shared instant, so a pair
that has just changed is not yet the one the whole group is on. Publishing it
straight away would put two mappings live at once, and a task that changed hands
could be picked up twice. So a worker owns a slot only when the interval before
last implied the same pair, and otherwise owns nothing until it does. Two
answers in a row are what issue the lease; a disagreement is what withholds it.

That is what makes the lease exclusive, and it needs no coordinator. At any
moment the group spans two consecutive intervals at most. Owning `i` through the later one
means having held `i` through the earlier one too, and `INCR` hands out distinct
indices inside an interval — so the two claimants are the same worker. What it
costs is a stand-down: any change to `n` changes every pair, so the whole group
lets go for an interval and comes back together, on the same slots. Registration
carries on throughout, which is what brings the group back to the arrangement it
had.

### Registration timing

Workers do not all register at the same moment. Each fires at `(i + 0.5) / n` of
the interval, worked out from the values its previous call returned. Ordering
then stops depending on network jitter, and the arrangement is
self-reinforcing: a worker holding index 2 of 5 fires third and is handed index
2 again.

The spread covers `interval - 2 * gap`, so nobody sits on a boundary where a
little jitter would carry the registration into the neighbouring key. The same
`gap` is how far past its slot a worker may drift before it stands down — one
number, because the two have to agree: a worker that missed a registration is
running on a mapping two intervals old, and it has to be gone before anyone
takes up a newer one. Standing down `gap` late always beats the `2 * gap` the
band leaves for it, whatever the gap is set to.

Widening it makes the scheme more forgiving of slow round trips and stalled
event loops, at the cost of bunching registrations toward the middle of the
interval. Narrowing it does the reverse; below about `0.125` a single failed
registration costs the worker a cycle, because the first retry no longer lands
inside the slack. It has to sit between 0 and 0.5.

A settled group keeps its assignment indefinitely. A join shifts only the
indices after the insertion point; a departure shifts only those after the gap.
Two workers that do collide are handed different indices and separate on the
next interval.

Registration is independent of ownership: a worker holds its slot in the
interval throughout a stand-down, so the group comes back onto the indices it
already had rather than having to agree on an order again.

## What this does not give you

**Ownership is eventual.** The pair in force describes intervals that have
already closed, so membership changes take two to three of them to show up. This
suits groups that tolerate controlled rebalancing; it is not a substitute for a
real coordination protocol when ownership must change immediately and
consistently.

**Rebalances cost an interval.** No two workers are ever handed the same index
at the same moment, but the price is that a membership change stands the whole
group down for about an interval before it comes back on the new `n`. Groups
that would rather keep serving through a rebalance, and fence the work
themselves, want a different scheme.

**The guarantee ends at the loop body.** What the group never does is hand the
same index to two workers at once. What happens to work already in flight is
yours: a consumer that keeps going after it has been handed a new pair, instead
of draining first, can still finish a task another worker has since started.

**A worker that registers and then dies leaves its slot unowned** until the next
interval, because the count is a snapshot of who _was_ present. No membership
scheme avoids this; only a shorter interval narrows it.

**Registration failures are silent.** A blip is retried within the interval and
costs nothing. Drifting past the slot it was due in by more than the gap expires
the lease and hands the loop the idle pair rather than raising — whether the
registration failed, or hung and never came back at all. A worker Redis has
stopped counting stops consuming, and comes back the long way round, exactly as
a restart would.

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
  passes `check` and carries an approving review.
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
