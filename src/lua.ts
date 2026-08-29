/**
 * Registers the caller in the current interval and reports the previous one.
 *
 * `KEYS[1]` is the hash-tag base for the group, for example `{mail-sender}`.
 * The interval keys are built inside the script so that `N` is derived from the
 * server's own clock — every worker then agrees on `N` by construction, and
 * clock skew between workers stops mattering. Both keys carry the same hash
 * tag, so they share a slot and the script is safe under Redis Cluster.
 *
 * `ARGV` is `[intervalMs, ttlMs]`. The reply is
 * `[N, rawIndex, previousCount, serverTimeMs]`, with `previousCount` reported
 * as `-1` when the previous interval's key is absent — a `nil` in the middle of
 * a Lua table truncates the reply, so the absence has to carry a value.
 */
export const REGISTER = `
local interval = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local n = math.floor(now / interval)

local current = KEYS[1] .. ':' .. n
local index = redis.call('INCR', current)
redis.call('PEXPIRE', current, ttl)

local previous = redis.call('GET', KEYS[1] .. ':' .. (n - 1))

return { n, index, previous and tonumber(previous) or -1, now }
`
