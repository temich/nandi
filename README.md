# n-and-i

Distributed peer indexing with Redis.

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

## License

[MIT](LICENSE) © Artem Gurtovoi
