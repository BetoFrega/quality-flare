# Running tests

quality-flare has two checks that run a repository's tests. This page helps you pick one, then walks through setting it up, from the defaults to the options that make runs faster and cheaper. Every option lives in `quality-flare.json` at the repository root; [Configuration](configuration.md) lists them all.

## Tests or Container tests

| | [Tests](checks.md#tests) | [Container tests](checks.md#container-tests) |
| --- | --- | --- |
| Where it runs | Dynamic Workers, the Workers runtime | A Linux container with Node 24, 4 vCPU and 12 GiB |
| What runs | Your test files, with vitest's runner and `expect`, but not vitest itself | Your own `vitest run`, with your vitest config |
| Setup | Usually none | Usually none for the tests; you add commands such as typecheck and lint |
| Good for | Unit tests of code that runs on Workers or in the browser | Anything that needs Node: processes, sockets, the file system, native modules, a typecheck, a linter |
| Can't do | Network, processes, `vi.mock`, Node-only APIs beyond `nodejs_compat` | Network-free isolation: the container can reach the internet |
| Cost | Cheapest per run | A few US cents per run, by the minute |

Both can be on for the same repository, for example the unit tests in Tests and everything else in Container tests. Both need Workers Paid on the instance's Cloudflare account.

## Tests: the zero-config check

Turn it on in the admin and open a pull request. It finds `*.test.*` and `*.spec.*` files, resolves imports like a bundler, and installs npm packages from the lockfile; [Checks](checks.md#tests) has the full convention.

It also reads your vitest config (`vitest.unit.config.*` or `vitest.config.*`) for the values written in it, such as `include`, `setupFiles` and `globals`. Add a `tests` section only for what it can't read there, such as a value computed at run time; the section wins over the vitest config:

```json
{
  "tests": {
    "include": ["src/**/*.test.ts"],
    "setupFiles": ["test/setup.ts"],
    "globals": true
  }
}
```

A test that only works on Node can skip itself on Workers:

```ts
describe.skipIf(navigator.userAgent === "Cloudflare-Workers")("reads files", () => { /* … */ });
```

## Container tests: your own vitest

With no config, each run clones the pull request merged into its base branch, installs dependencies from the lockfile, and runs `npx vitest run`. That means:

- **vitest must be a dependency** of the repository (it runs with `npx --no-install`). Live progress on the check run needs vitest 3 or newer.
- **Dependencies install without install scripts:** `pnpm install --frozen-lockfile --ignore-scripts`, `yarn install --frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts`, by whichever lockfile the repository has. If your tests need a build step or install scripts, set `install` to your own command, such as `"install": "npm ci && npm run build"`.
- **vitest finds its config as usual.** To pass arguments, such as another config file or one project, use `vitestArgs`: `"vitestArgs": ["--project", "unit"]`.

```json
{
  "container": {
    "vitestArgs": ["--config", "vitest.ci.config.ts"]
  }
}
```

### Add commands: typecheck, lint

Each entry of `commands` runs after the install, beside the tests, and reports as its own check run with the entry's name. Commands run one after another, at a lower priority than the tests, with `CI=true`, `GITHUB_BASE_REF` and `GITHUB_SHA` set as on GitHub Actions. A command fails its check run when it exits with a non-zero code.

```json
{
  "container": {
    "commands": {
      "Typecheck": "npx tsc --noEmit",
      "Lint": "npx eslint ."
    }
  }
}
```

Up to 8 commands, 15 minutes each. `"typecheck": "…"` is a shorthand for a command named **Typecheck** that runs first.

The base branch is fetched as `origin/<base>`, so commands can compare against it, for example `git diff --name-only origin/main`.

## Run only the tests a change affects

On a large suite, most of a run tests code the pull request didn't touch. With `"changed": true`, each pull request runs only the test files whose imports reach a changed file (vitest's `--changed origin/<base>`). A change to `package.json` or a lockfile counts as a change to the files that use the packages that changed.

```json
{
  "container": {
    "changed": true,
    "alwaysRun": ["test/cli/"]
  }
}
```

vitest follows imports, so it misses tests that depend on a file another way: a test that reads a fixture from disk or runs a script as a child process. List those in `alwaysRun` (vitest filters, such as a folder) and they run on every pull request.

`changed` also turns on the **daily full run**: every day at 09:00 UTC, the default branch's latest commit runs every test and every command, unless that commit already had a full run. When it fails, quality-flare opens an issue on the repository. The full run is also what saves the [tool caches and snapshots](#make-runs-faster) below.

## Make runs faster

Three independent options. Each has requirements, listed with it.

### Turborepo remote cache

If your commands run [Turborepo](https://turborepo.com) tasks, `turboCache` gives them a remote cache on the instance's R2 bucket, shared by every run of the repository. A task whose inputs an earlier run already built comes from the cache instead of running again.

**What you need:**

- The repository uses Turborepo, and the commands call it, such as `npx turbo run typecheck lint`.
- `"turboCache": true` in the `container` section.
- Nothing in `turbo.json`. quality-flare sets `TURBO_API`, `TURBO_TEAM` and `TURBO_TOKEN` for the commands, which is how Turborepo finds a remote cache. Don't set those variables in the commands, and don't turn remote caching off in `turbo.json`.

```json
{
  "container": {
    "turboCache": true,
    "commands": {
      "Typecheck": "npx turbo run typecheck",
      "Lint": "npx turbo run lint --affected"
    }
  }
}
```

**How it behaves:**

- Each repository has its own cache: a run's token reads and writes only that repository's artifacts.
- Pull request runs read and write the cache.
- The daily full run sets `TURBO_FORCE=true`, so it runs every task again instead of trusting the cache, and stores fresh results.
- `--affected` works on pull requests, against `origin/<base>`. On the daily full run, quality-flare points `TURBO_SCM_BASE` at an empty commit, so `--affected` sees every package as changed and runs everything.
- The instance's operator can expire old artifacts with a lifecycle rule on the R2 bucket; see [Self-hosting](self-hosting.md#optional).

The Tests check doesn't use Turborepo; this only applies to Container tests.

### Tool caches

Tools such as ESLint and `tsc` can skip work when they find their cache from an earlier run. `cache` keeps the paths you list from one run to the next.

```json
{
  "container": {
    "changed": true,
    "cache": ["node_modules/.cache/eslint", "tsconfig.tsbuildinfo"],
    "commands": {
      "Typecheck": "npx tsc --build",
      "Lint": "npx eslint --cache --cache-location node_modules/.cache/eslint --cache-strategy content ."
    }
  }
}
```

**What you need:**

- `"changed": true`: only the daily full run saves the cache, and the full run only exists with `changed`. Pull request runs only restore it, so a pull request's code can't leave a cache that vouches for files nobody checked.
- npm with a `package-lock.json` whose every package is pinned by `integrity` (or is a link to a folder of the repository), and no custom `install`. Otherwise what lands in `node_modules` could change without the cache noticing, so the cache stays off.
- Tools that only skip work whose inputs didn't change, such as ESLint with `--cache-strategy content` and incremental `tsc`.

Each path must be inside the repository and outside `.git`. A path that holds versioned files, or has a symlink in it, isn't restored. A new lockfile, `package.json` or path list starts a new cache. Caches over 90 MB compressed aren't saved.

### Container snapshots

Most of a run's setup is the install. With `"snapshot": true`, the daily full run saves a [snapshot](https://developers.cloudflare.com/containers/guides/snapshots/) of the container right after installing dependencies, before running any of the repository's code. Pull request runs start from it, with the clone and `node_modules` in place, and skip the install while the lockfile, the `package.json` files, the package manager's config and `install` are the same as the snapshot's.

**What you need:** the same as tool caches: `"changed": true`, npm with an `integrity`-pinned `package-lock.json`, and no custom `install`.

## A complete example

A monorepo with Turborepo, unit tests in their own vitest project, a typecheck and a lint, running only what a pull request affects:

```json
{
  "container": {
    "vitestArgs": ["--project", "unit"],
    "changed": true,
    "alwaysRun": ["scripts/"],
    "turboCache": true,
    "cache": ["node_modules/.cache/eslint"],
    "snapshot": true,
    "commands": {
      "Typecheck": "npx turbo run typecheck",
      "Lint": "npx eslint --cache --cache-location node_modules/.cache/eslint --cache-strategy content ."
    }
  }
}
```

Every key is optional. Start with nothing, add `commands`, and add the rest when runs get long.
