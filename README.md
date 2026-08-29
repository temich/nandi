# redin

A TypeScript package for Node >= 24. `tsc` emits `dist/` (JS + `.d.ts` +
sourcemaps); `src/` ships alongside it so the sourcemaps resolve.

> The sources are `.ts`, but they cannot be the published artifact: Node refuses
> to strip types for files under `node_modules`
> (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Hence the emit step.
>
> `erasableSyntaxOnly` is on regardless, so `enum`, `namespace` and parameter
> properties stay out — tests run straight off `src/` under Node's type
> stripping, with no build in the loop.

## Development

```sh
npm install
npm run check   # typecheck + lint + format check + tests
npm run build   # emits dist/
```

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

- `dev` — the working branch.
- `release` — every push runs the checks and then `semantic-release`, which
  derives the version from the commit messages, publishes a GitHub Release with
  the generated notes, and commits the version bump back.

The package is `private`, so `@semantic-release/npm` only bumps the version and
does not publish to the registry. To publish, drop `"private": true`, add
`"publishConfig": { "access": "public" }`, and give the release workflow an
`NPM_TOKEN`.
