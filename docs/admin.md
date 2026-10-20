# Admin

The admin at `/admin` lists the repositories where the App is installed. Everything starts disabled.

## Repositories and checks

- The **Ativar checks** switch of each repository turns quality-flare on for it. While it is off, the Worker ignores that repository's webhooks and creates no check runs.
- Clicking a repository opens its checks, each with its own switch, and the **Ativar todos** and **Desativar todos** buttons.
- In an enabled repository, a check that is off doesn't run and is reported as `neutral` ("Desativado"), so a check that branch protection requires doesn't block merging.
- The [tests on demand](on-demand.md) option is set here too.
- The list can be filtered by name and state and sorted.

Each check has a stable `id` (for example `closes-issue`), which is what is saved. Don't change the `id` of a check that is already published.

## Runs

`/admin/runs` lists the 50 most recent runs of the Tests and Container tests checks (the **Check** column tells them apart): running, passed, failed, neutral, or interrupted (still "running" after 75 minutes). A running run says for how long ("Rodando há 48 min"); past the run deadline (60 minutes) it is flagged as probably stuck, since the cron should already have failed it. Pages follow along live: each test appears as soon as it ends, with the count ("12 de 40 · 1 falhou"); when a run starts or ends, the page reloads and keeps its scroll position.

Each run opens with a link to its PR (or commit, for a full run), then its failures (file › test, with the message), then every file, the failing ones open, and finally its usage and estimated cost: the Dynamic Workers it used and their crashes, or the container's.

Without JavaScript, the page reloads every 5 seconds.

## Costs

`/admin/costs` shows two things side by side:

- **Measured usage** of the Cloudflare account for the month and each day (Dynamic Workers, CPU, errors, and the containers' memory, CPU and disk against the month's allowance), read from the GraphQL Analytics API with the `quality-flare-analytics-token` from Secrets Store. Without that token, see [Self-hosting](self-hosting.md#optional), only the estimates show.
- **Estimates** per run, repository, day and month, from what each batch delivery and each container recorded in D1.

## Sign-in

A self-hosted Cloudflare Access application covers `/admin` and `/admin/*`. The Worker also checks `ctx.access` and requires the `aud` to be that application's (`ACCESS_AUD`), so the admin refuses any request that didn't go through Access. Without `ACCESS_AUD`, the admin stays closed.

## Storage

- **Settings:** the KV namespace bound as `SETTINGS`, key `repo:<owner/repo>`, value like `{ "enabled": true, "enabledChecks": ["closes-issue"] }`.
- **Run history:** the D1 database `quality-flare-runs` (binding `RUNS`). The Worker creates its tables on first use; there is no migration to run.
- **Live updates:** the Durable Object `RunsHub` (binding `LIVE`) relays test events to admin pages over a WebSocket at `/admin/live`, behind Access and same-origin only. Opening a page in the middle of a run replays the progress so far.
