# Configuration

A repository configures quality-flare with an optional `quality-flare.json` at its root. Most repositories don't need one for the [Tests](checks.md#tests) check. When a pull request doesn't have the file, the base branch's file applies.

The file has two independent sections: `tests` for the Tests check (Dynamic Workers) and `container` for the Container tests check.

```json
{
  "tests": { "include": ["src/**/*.test.ts"] },
  "container": {
    "vitestArgs": ["--config", "vitest.unit.config.mts"],
    "install": "npm ci",
    "commands": {
      "Typecheck": "npm run typecheck",
      "Lint": "npm run lint"
    }
  }
}
```

## tests

Mirrors the vitest config the tests come from.

| Key | Type | What it does |
| --- | --- | --- |
| `include` | list of globs | Test files, as vitest's `include`. Replaces the `*.test.*` convention |
| `exclude` | list of globs | Files left out, as vitest's `exclude`; `node_modules` is always left out |
| `setupFiles` | list of paths | Files run before each test file |
| `globals` | boolean | Exposes `describe`, `it`, `expect`, `vi`… as globals |
| `testTimeout` | milliseconds | Time per test |
| `environment` | text | vitest's `environment` (`node`, `jsdom` or `happy-dom`) for files without a `@vitest-environment` comment |
| `restoreMocks`, `mockReset`, `clearMocks` | boolean | As vitest's options of the same name. `clearMocks` defaults to vitest's own default for the version in the lockfile |

## container

The repository's own vitest and config run in the container, so the `tests` section doesn't apply here.

| Key | Type | What it does |
| --- | --- | --- |
| `vitestArgs` | list of texts | Arguments to `vitest run` |
| `install` | shell command | Replaces the install command, which by default is the lockfile's package manager without install scripts |
| `commands` | object | Up to 8 commands, `{ "Check run name": "command" }`, run after the tests in order, each reported as its own check run |
| `typecheck` | shell command | Shorthand for a **Typecheck** command, run before the others |
| `changed` | boolean | Runs only the tests that depend on what the pull request changed. See [Only the tests that changed](on-demand.md#only-the-tests-that-changed) |
| `alwaysRun` | list of paths | With `changed`, vitest filters that run on every pull request anyway, such as tests that read files or run scripts |
| `turboCache` | boolean | Gives Turborepo, in the commands, a remote cache on R2 shared by the repository's runs |
| `cache` | list of paths | Paths kept between runs, such as `node_modules/.cache/eslint` or `tsconfig.tsbuildinfo` |
| `snapshot` | boolean | Starts pull request runs from a snapshot taken after the install, skipping it |

### Caches

`cache` keeps the listed paths from the daily full run for the pull request runs of the same repository. They are kept in R2, one per combination of lockfile, `package.json`, `install` and path list. Pull requests only read them, so a pull request's code can't leave behind a cache that marks as checked something nobody checked. Use it for tools that skip what didn't change, such as `eslint --cache --cache-strategy content` and incremental `tsc`.

Each path must be below the repository root and outside `.git`. A path holding versioned files, or with a symlink in it, above or below, isn't restored.

### Snapshots

`"snapshot": true` makes the daily full run on the default branch (which only exists with `"changed": true`) save a [snapshot](https://developers.cloudflare.com/containers/guides/snapshots/) of the container right after installing dependencies, before running any other code from the repository. Pull request runs start from it, with the clone and `node_modules` in place, and skip the install while the lockfile, the `package.json` files, the package manager's config (`.npmrc`, `pnpm-workspace.yaml`…) and `install` are the same.

Only the default branch writes the snapshot, because the install runs as root and the snapshot keeps the whole file system: a pull request's code could leave anything in it for later runs.

### When the install can be reused

The install is only reused (skipped, through the snapshot or the cache) with npm and a `package-lock.json` whose every package is pinned by `integrity` or is a link to a folder of the repository ([`qf-reusable.mjs`](../containers/tests/qf-reusable.mjs)). Otherwise, what lands in `node_modules` could change without changing the files of the key: a local package packed with `install-links`, a git dependency, a pnpmfile, Yarn's config, pnpm's injected packages. With a custom `install`, both the cache and the snapshot are off, because an install script can change without changing the files that say whether the install can be skipped.

## Worker settings

In `cloudflare.config.ts` of your [own instance](self-hosting.md):

| Variable | Default | What it does |
| --- | --- | --- |
| `NO_ISSUE_LABEL` | `no-issue` | Label that exempts a pull request from **Closes an issue** |
