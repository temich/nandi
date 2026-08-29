# Contributing

## Working on a change

The tests run against a real Redis and fail without one:

```sh
docker run --rm -p 6379:6379 redis:8-alpine

npm install
npm run check
```

`REDIS_URL` points them at another server, and `TEST_INTERVAL` raises the
interval they run at if the machine is slow.

Branch off `dev`, and open a pull request back into it. A pull request needs a
passing `ci` run, an approving review, and every review thread resolved.

Commit messages must follow [conventional commits](https://www.conventionalcommits.org)
— `commit-msg` lints them locally, and they decide the next released version:
`fix:` a patch, `feat:` a minor. A `!` or a `BREAKING CHANGE:` footer also
releases a minor while the package is pre-1.0.

## Releasing

Merge `dev` into `release` through a pull request. That is the whole release
procedure — `semantic-release` reads the commits since the last tag, and then
tags, publishes to npm, and writes the GitHub Release. Nothing is published
from a laptop, and no version number is edited by hand.

Both branches reject force-pushes and deletion, as do the `v*` tags: a released
version can never be moved or removed.
