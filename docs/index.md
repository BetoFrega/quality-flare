# quality-flare

quality-flare is continuous integration that runs entirely on Cloudflare, delivered as a GitHub App. Each check becomes a check run on your pull requests, so branch protection can require it like any other status check.

The whole service is one Cloudflare Worker. It receives GitHub's webhooks, runs the checks you turned on for the repository, and reports back. Tests run in [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) created for each run, or in a [container](https://developers.cloudflare.com/containers/) started for each run. Settings live in KV, run history in D1, caches in R2, and the admin sits behind Cloudflare Access. Nothing runs outside your Cloudflare account.

## What you get

| Check | What it does |
| --- | --- |
| [Tests](checks.md#tests) | Runs the repository's vitest tests in Dynamic Workers, with no vitest install and usually no config |
| [Container tests](checks.md#container-tests) | Runs the repository's own vitest and config in a container, then named commands such as Typecheck and Lint, each as its own check run |
| [Closes an issue](checks.md#closes-an-issue) | Requires the pull request to close an issue, unless it has the `no-issue` label |
| [Codex review](checks.md#codex-review) | Requires every Codex review thread to be resolved before merging |
| [Dependabot auto-merge](checks.md#dependabot-auto-merge) | Turns on squash auto-merge for Dependabot pull requests |

Around the checks:

- **[Tests on demand](on-demand.md):** pushes wait, and a `/quality-flare run` comment runs the current commit once. Made for agents that push often and only need CI at the end.
- **[Only what changed](on-demand.md#only-the-tests-that-changed):** pull requests run the tests that depend on the change, and a daily full run on the default branch catches what that misses.
- **[Admin](admin.md):** turn repositories and checks on one by one, follow runs live, and see what each run cost.

## Where to go next

- **Run your own instance:** [Self-hosting](self-hosting.md). You need a Cloudflare account on Workers Paid and a GitHub account; nothing is installed on your computer.
- **Set up a repository:** [Configuration](configuration.md) describes `quality-flare.json`, which most repositories don't need for the Tests check.
- **Understand the moving parts:** [Architecture](architecture.md).

The source is on [GitHub](https://github.com/BetoFrega/quality-flare) under the MIT license.
