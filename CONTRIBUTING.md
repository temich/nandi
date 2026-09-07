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
passing `check` run, an approving review, and every review thread resolved.

Commit messages must follow [conventional commits](https://www.conventionalcommits.org)
— `commit-msg` lints them locally, and they decide the next released version:
`fix:` a patch, `feat:` a minor. A `!` or a `BREAKING CHANGE:` footer also
releases a minor while the package is pre-1.0.

## Dependency bumps

Dependabot opens its bumps against `dev` weekly, and they merge themselves: the
`dependabot` workflow approves each one and arms auto-merge, so a bump lands the
moment `check` goes green — and never lands without it. Major versions are in
too; nothing is held back for a second pair of eyes.

The approval comes from the Actions token, so _Allow GitHub Actions to create
and approve pull requests_ has to stay on in the repository settings. To keep a
bump out, close it, or comment `@dependabot ignore this major version` on it —
that stops the next one as well.

## Releasing

Merge `dev` into `release` through a pull request. That is the whole release
procedure — `semantic-release` reads the commits since the last tag, and then
tags, publishes to npm, and writes the GitHub Release. Nothing is published
from a laptop, and no version number is edited by hand.

Both branches reject force-pushes and deletion, as do the `v*` tags: a released
version can never be moved or removed.
