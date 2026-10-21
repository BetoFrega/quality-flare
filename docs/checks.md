# Checks

Each check reports as its own check run on the pull request's head commit. Checks are turned on per repository in the [admin](admin.md); in an enabled repository, a check that is off is reported as **neutral** ("Disabled"), so a check that branch protection requires doesn't block merging.

To add a check, implement the `Check` interface of [`src/checks/types.ts`](../src/checks/types.ts) and register it in [`src/checks/index.ts`](../src/checks/index.ts).

## Tests

Needs **Workers Paid**, like Container tests: on a free Cloudflare account the deploy leaves both out (see [Self-hosting](self-hosting.md#workers-free-or-workers-paid)).

Runs the repository's tests on the pull request's head commit inside a [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) created on the spot, with vitest's runner and `expect` (`@vitest/runner` and `@vitest/expect`), without vitest itself.

The convention, with no per-repository config:

- **Which files:** every `*.test.{ts,mts,js,mjs}` and `*.spec.{ts,mts,js,mjs}`, outside `node_modules`, `dist`, `build`, `coverage` and hidden folders. The repository's vitest config (`vitest.unit.config.*` or `vitest.config.*`) and the `tests` section of `quality-flare.json` can change that; see [Configuration](configuration.md#tests).
- **API:** import from `"vitest"` as usual: `describe`, `it`/`test`, hooks (`beforeEach`…), `expect` (Jest matchers, `expect.objectContaining`, `expect.assertions`…) and `vi` (`vi.fn`, `vi.spyOn`, `vi.stubGlobal`, `vi.unstubAllGlobals`, `vi.restoreAllMocks`).
- **Imports:** TypeScript is stripped on the fly; `./a`, `./a.js` and `./a/index.ts` find `a.ts`, as in a bundler. npm packages come from the lockfile (`pnpm-lock.yaml` or `package-lock.json`), at the exact version, downloaded from the registry. `tsconfig.json` `paths` and workspace packages (npm and pnpm) resolve too. Playwright specs (`@playwright/test`) are left out. Node modules (`node:crypto`, `crypto`…) work through `nodejs_compat`.
- **Environment:** the Workers runtime, with no network (`fetch` only works if the test stubs it), and a limit of 120 s of CPU and 5 minutes of wall time per batch.
- **Batches:** files run in batches, one Dynamic Worker per batch, two at a time, spread through the Cloudflare Queue `quality-flare-tests`. A batch groups up to 30 files that import the same code, up to about 32 MB of code by what each file loaded last time. A batch that is too big, or that crashes the Worker, splits in half until it fits.

Results:

- ✅ passes when every test passes; ⚪ neutral when the repository has no tests; ❌ fails with each failed test and its `expect` message.
- Runs when the pull request is opened, reopened, gets commits or leaves draft (not on label or description changes), and on **Re-run**.

A test that only works on Node can skip itself on Workers with `describe.skipIf(navigator.userAgent === "Cloudflare-Workers")`.

## Container tests

Runs the repository's own vitest, with its own config, in a [container](https://developers.cloudflare.com/containers/) created for each run (image in [`containers/tests`](../containers/tests), Node 24, instance `standard-4`: 4 vCPU, 12 GiB). It is for what doesn't run in a Dynamic Worker: tests that need processes, sockets, `vm`, native modules, or a typecheck. It is a separate check from **Tests**: both are turned on one by one in the admin, and a repository can use both, for example cheap unit tests in Tests and the rest here.

- **Steps:** clones the pull request's commit, with the base branch's history in `origin/<base>`, using a token that can only read that repository, and merges the base into it, as GitHub Actions does on `pull_request` (on a conflict, the check fails asking to resolve it). Installs dependencies from the lockfile without install scripts (or runs your `install`), then runs `vitest run` and, beside it, each configured command in order.
- **Commands:** each entry of `container.commands` reports as a check run with that name, such as **Typecheck** or **Lint**. [Running tests](running-tests.md#container-tests-your-own-vitest) shows how to set them up, and [Configuration](configuration.md#container) lists every option.
- **While it runs:** every 10 seconds the **Container tests** check run shows how many tests passed and each failure as it appears (vitest 3 or newer), and each command's check run shows the end of its log so far. Each command completes its check run as soon as it ends, without waiting for the tests. The run's page in the admin shows the same, live.
- **Limits:** clone 5 minutes, install 10 minutes, tests 15 minutes, each command 15 minutes. The container is destroyed when it ends, on a new push to the pull request, or after 20 minutes.
- **Cost:** memory and disk for the time it is up, CPU for what it used. A run that takes 4 to 10 minutes costs a few US cents. Each run's page in the admin shows its estimated cost, and [Costs](admin.md#costs) the totals.

Results: ✅ passes when every test passes; ⚪ neutral when vitest finds no tests; ❌ fails with each failed test, or with the log of the step that failed.

## Closes an issue

- ✅ Passes when the pull request closes at least one issue: a keyword in the description (`Closes #12`, `fixes owner/repo#3`, `Resolves https://github.com/o/r/issues/7`) or an issue linked in the **Development** section of the sidebar.
- ✅ Passes when the pull request has the `no-issue` label (`NO_ISSUE_LABEL` in `cloudflare.config.ts`).
- ⏭️ Skips (counts as passing) pull requests that don't target the default branch, drafts (unless they have the `run-ci` label) and pull requests by `dependabot[bot]`.
- ❌ Fails in any other case, with instructions on how to fix it.

Linking an issue from the sidebar sends no webhook. After linking, press **Re-run** on the check (or edit the description) to evaluate it again.

## Codex review

Makes sure the reviews of [Codex](https://chatgpt.com/codex) (`chatgpt-codex-connector[bot]`) were dealt with before merging.

- ❌ Fails while any conversation Codex opened isn't resolved, including outdated ones. The summary lists each suggestion with its priority (P0, P1…) and link.
- 🟡 Stays pending (check run in progress) while Codex is reviewing: its "Codex Review Summary" comment shows a review in progress, or, without that comment, Codex reacted with 👀 on the pull request.
- ✅ Passes when Codex reviewed and every one of its conversations is resolved, or when it left no suggestions.
- ⚪ Neutral while Codex hasn't reviewed the pull request.
- Runs on pull request events, on each review, review comment, resolved or reopened conversation and pull request comment (Codex edits its summary when it finishes), and on **Re-run**.

With [tests on demand](on-demand.md), a `/quality-flare run` comment doesn't start tests while this check is blocking.

## Dependabot auto-merge

Does what a `gh pr merge --auto --squash` workflow does for Dependabot pull requests, without GitHub Actions.

- ✅ On a pull request opened by `dependabot[bot]`, turns on squash auto-merge (GraphQL `enablePullRequestAutoMerge`). The pull request merges when the required checks pass.
- ⚪ Neutral on pull requests by other authors, and on a Dependabot pull request that can already merge: GitHub only accepts auto-merge while required checks are pending. When the base branch changes, Dependabot rebases and the check tries again.
- ❌ Fails when GitHub refuses, with the message and how to fix it (for example, auto-merge turned off in the repository).
- Runs when the pull request is opened, reopened, gets commits or leaves draft, and on **Re-run**.
- Requires **Allow auto-merge** in the repository's Settings → General, and the App with Contents and Pull requests as **Read and write**. For auto-merge to wait for anything, the repository must require at least one check in branch protection.
