# Configuration

Every key a repository can set in `quality-flare.json`, at the repository root. The file is optional, and so is every key in it. [Running tests](running-tests.md) explains when to use each one; this page is the reference.

- **Where it is read from:** the pull request's head commit. When the pull request doesn't have the file, the base branch's file applies, so a repository can add it in its own pull request.
- **When it is invalid:** the check that reads it fails, with the key that is wrong and why.
- **Two sections, independent of each other:** `tests` is read only by the [Tests](checks.md#tests) check, and `container` only by [Container tests](checks.md#container-tests).

```json
{
  "tests": {
    "include": ["src/**/*.test.ts"]
  },
  "container": {
    "commands": {
      "Typecheck": "npx tsc --noEmit",
      "Lint": "npx eslint ."
    }
  }
}
```

## tests

The Tests check doesn't run vitest, but it reads the repository's vitest config without running it: the first of `vitest.unit.config.*` and `vitest.config.*` it finds at the root (`.mts`, `.ts`, `.mjs`, `.js`, `.cts`, `.cjs`). It takes the literal values written in its `test: { … }` blocks, following `mergeConfig` into local config files it imports; values computed at run time are left out.

This section sets the same options, and wins over the vitest config key by key. Use it when the vitest config computes a value, or when the Tests check should run something different from it. Without either, the [convention](checks.md#tests) applies.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `include` | list of globs | `*.test.*` and `*.spec.*` files | Test files, as vitest's `include` |
| `exclude` | list of globs | none | Files left out, as vitest's `exclude`; `node_modules` is always left out |
| `setupFiles` | list of paths | none | Files run before each test file |
| `globals` | boolean | `false` | Exposes `describe`, `it`, `expect`, `vi`… as globals |
| `testTimeout` | milliseconds | vitest's default | Time limit per test |
| `environment` | text | `node` | vitest's `environment` (`node`, `jsdom` or `happy-dom`) for files without a `@vitest-environment` comment |
| `restoreMocks`, `mockReset`, `clearMocks` | boolean | vitest's default for the version in the lockfile | As vitest's options of the same name |

## container

Container tests runs your own vitest with your own vitest config, so test options go in that config, not here. This section says how to install, what else to run, and how to make runs faster.

### Install and tests

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `install` | shell command | by lockfile: `pnpm install --frozen-lockfile --ignore-scripts`, `yarn install --frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts --no-audit --no-fund` | Replaces the install. Use it when the tests need install scripts or a build first, such as `"npm ci && npm run build"`. Turns off `cache` and `snapshot` |
| `vitestArgs` | list of texts | none | Arguments added to `vitest run`, such as `["--config", "vitest.ci.config.ts"]` or `["--project", "unit"]` |

### Commands

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `commands` | object | none | `{ "Check run name": "shell command" }`. Each runs after the install, beside the tests, one after another, and reports as its own check run with that name |
| `typecheck` | shell command | none | Shorthand for a command named **Typecheck** that runs before the others. Don't also name one of `commands` "Typecheck" |

- Up to 8 commands, including `typecheck`. Names up to 60 characters.
- Each command has 15 minutes, and fails its check run when it exits with a non-zero code.
- Commands get `CI=true`, `GITHUB_BASE_REF` and `GITHUB_SHA`, as on GitHub Actions, and the base branch as `origin/<base>`.

### Affected tests

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `changed` | boolean | `false` | Pull requests run only the test files whose imports reach a changed file. Also turns on the daily full run on the default branch. See [Run only the tests a change affects](running-tests.md#run-only-the-tests-a-change-affects) |
| `alwaysRun` | list of vitest filters | none | With `changed`, tests that run on every pull request anyway, such as `["test/cli/"]`: tests that read files or run scripts, which vitest's import graph doesn't connect to a change |

### Speed

All three are explained, with their requirements, in [Make runs faster](running-tests.md#make-runs-faster).

| Key | Type | Default | Requires | What it does |
| --- | --- | --- | --- | --- |
| `turboCache` | boolean | `false` | Turborepo in the commands | Sets `TURBO_API`, `TURBO_TEAM` and `TURBO_TOKEN` so Turborepo uses a remote cache on the instance's R2, one per repository |
| `cache` | list of paths | none | `changed`, npm with an `integrity`-pinned `package-lock.json`, no `install` | Paths the daily full run saves and pull request runs restore, such as `node_modules/.cache/eslint` or `tsconfig.tsbuildinfo` |
| `snapshot` | boolean | `false` | Same as `cache` | The daily full run saves the container right after the install; pull request runs start from it and skip the install |

Paths in `cache` must be inside the repository and outside `.git`. A path that holds versioned files, or has a symlink in it, isn't restored.

#### Why the install must be pinned

`cache` and `snapshot` both skip work by trusting that `node_modules` is what the lockfile says. That only holds with npm and a `package-lock.json` whose every package is pinned by `integrity` or is a link to a folder of the repository ([`qf-reusable.mjs`](../containers/tests/qf-reusable.mjs)). With other package managers, a git dependency, a pnpmfile, Yarn's config or a custom `install`, what gets installed can change without the lockfile changing, so both stay off and runs install as usual.

Only the daily full run on the default branch writes them, because a pull request's code could otherwise leave something in them for later runs.

## Instance settings

These belong to the [instance](self-hosting.md), not to a repository, in its `cloudflare.config.ts`:

| Variable | Default | What it does |
| --- | --- | --- |
| `NO_ISSUE_LABEL` | `no-issue` | Label that exempts a pull request from **Closes an issue** |
