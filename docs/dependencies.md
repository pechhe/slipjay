# Dependencies

Short map for dependency updates. The repository is authoritative; fix this file with any change that contradicts it.

## Surfaces

- `package.json` (dependencies, devDependencies, `packageManager`) and `bun.lock`. No workspaces, catalogs, overrides or patches.
- `slipjay.json` landing verification runs `bun install --frozen-lockfile`.

## Clusters

- Vite+: `vite-plus` and `vite` (`npm:@voidzero-dev/vite-plus-core`) move together at the same version.
- `effect` is an exact pin; move it deliberately (host code uses its vocabulary).
- `@types/bun` tracks the `packageManager` Bun pin; `@types/proper-lockfile` tracks `proper-lockfile`.
- `typescript`, `@types/node`: independent.

## Constraints

None intentional.

## Commands

- Outdated: `bun outdated`. Bump by editing `package.json`, then `bun install`.
- Verify: `bun run check`, `bun run typecheck`, `bun run test`.

## Ground rules

- Bun is the package manager (`packageManager` pin tracks the latest bun release). No other lockfiles.
