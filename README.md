# dpi

A TypeScript-only Node package: the `.ts` sources in [`src/`](src) **are** the
artifact. Node >= 24 strips the types at load time, so there is no build step,
no `dist/`, and no sourcemaps to keep in step.

`tsc` is present for typechecking only (`--noEmit`) — it never emits.

## Development

```sh
npm install
npm run check   # typecheck + lint + format check + tests
```

| script              | does                                  |
| ------------------- | ------------------------------------- |
| `npm run typecheck` | `tsc --noEmit`                        |
| `npm run lint`      | `oxlint .` (`lint:fix` to autofix)    |
| `npm run fmt`       | `oxfmt .` (`fmt:check` in CI)         |
| `npm test`          | `node --test` over `src/**/*.test.ts` |

`husky` runs `npm run check` on pre-commit and lints the message against
[conventional commits](https://www.conventionalcommits.org) on commit-msg.
CI re-runs `npm run check` on the `release` branch; `dev` is the working branch.

## Constraints of shipping `.ts`

- **Node only, >= 24.** `tsconfig.json` sets `erasableSyntaxOnly`, so the
  TypeScript that cannot be stripped (`enum`, `namespace`, parameter
  properties) is a type error rather than a runtime failure.
- **Not consumable from `node_modules`.** Node refuses to strip types for files
  under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). This
  package is `private`, so that is fine; if it ever has to be published for
  other packages to import, it needs an emit step again.
