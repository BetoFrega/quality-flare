# quality-flare

quality-flare is continuous integration that runs entirely on Cloudflare, delivered as a GitHub App. Each check becomes a check run on your pull requests, so branch protection can require it like any other status check.

The whole service is one Cloudflare Worker that you deploy to your own Cloudflare account, with your own GitHub App. It receives GitHub's webhooks, runs the checks you turned on for each repository, and reports back. Tests run in [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) or in a [container](https://developers.cloudflare.com/containers/) started for each run. Settings live in KV, run history in D1, caches in R2, and the admin sits behind Cloudflare Access. Nothing runs outside your Cloudflare account.

quality-flare isn't a hosted service you sign up for: each team runs its own instance. One instance serves every repository its GitHub App is installed on.

## What you get

| Check | What it does |
| --- | --- |
| [Tests](checks.md#tests) | Runs the repository's vitest tests in Dynamic Workers, with no vitest install and usually no config |
| [Container tests](checks.md#container-tests) | Runs the repository's own vitest and config in a container, then commands you name, such as Typecheck and Lint, each as its own check run |
| [Closes an issue](checks.md#closes-an-issue) | Requires the pull request to close an issue, unless it has the `no-issue` label |
| [Codex review](checks.md#codex-review) | Requires every Codex review thread to be resolved before merging |
| [Dependabot auto-merge](checks.md#dependabot-auto-merge) | Turns on squash auto-merge for Dependabot pull requests |

Around the checks:

- **[Tests on demand](on-demand.md):** pushes wait, and a `/quality-flare run` comment runs the current commit once. Made for agents that push often and only need CI at the end.
- **[Only the tests that changed](running-tests.md#run-only-the-tests-a-change-affects):** pull requests run the tests that depend on the change, and a daily full run on the default branch catches what that misses.
- **[Caches](running-tests.md#make-runs-faster):** a Turborepo remote cache, tool caches and container snapshots, all on R2.
- **[Admin](admin.md):** turn repositories and checks on one by one, follow runs live, and see what each run cost.

## Where to start

1. **[Self-hosting](self-hosting.md):** deploy your instance and create its GitHub App. You need a Cloudflare account and a GitHub account; nothing is installed on your computer.
2. **[Getting started](getting-started.md):** connect a repository and see the first check runs.
3. **[Running tests](running-tests.md):** pick between Tests and Container tests and configure them for your repository.

If someone on your team already runs an instance, skip to step 2.

The source is on [GitHub](https://github.com/BetoFrega/quality-flare) under the MIT license.
