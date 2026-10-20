# Architecture

quality-flare is one Cloudflare Worker, configured in [`cloudflare.config.ts`](../cloudflare.config.ts) and built and deployed with Cloudflare's CLI, [`cf`](https://www.npmjs.com/package/cf).

| Cloudflare product | What it is for |
| --- | --- |
| Workers | The webhook, the admin, `/setup`, these docs, and the Queue consumer |
| Dynamic Workers (binding `LOADER`) | One Worker per batch of the Tests check, loaded with the tests and the code they import |
| Queues (`quality-flare-tests`) | Batches of a Tests run, consumed by the same Worker |
| Containers (`TestBox` Durable Object) | One container per Container tests run |
| Durable Objects (`RunsHub`) | Live progress for the admin over WebSockets |
| D1 (`quality-flare-runs`) | Run history, batch attempts and container usage |
| KV (`SETTINGS`) | Per-repository settings |
| R2 (`quality-flare-turbo-cache`) | Turborepo cache, tool caches |
| Access | Sign-in for the admin |
| Cron Triggers | Overdue-run sweep every 5 minutes, daily full run at 09:00 UTC |
| Workers Builds | Builds and deploys on every push to `main` |

## A pull request, step by step

1. GitHub sends the webhook to the Worker, which verifies the `X-Hub-Signature-256` signature.
2. The Worker reads the repository's settings from KV. A repository that isn't enabled is ignored.
3. The Worker signs a JWT for the App (RS256, WebCrypto) and exchanges it for an installation token.
4. It answers GitHub right away and keeps working in `waitUntil`: it runs each enabled check and creates a check run per check on the pull request's head commit.
5. **Tests** only lists the test files, opens the check run as in progress and queues the batches. The same Worker consumes the Queue: each batch downloads the commit's tarball, builds the modules (tests, imported code and npm packages) and loads them into a Dynamic Worker. The last batch to finish completes the check run. The test runtime ([`src/checks/tests/runtime`](../src/checks/tests/runtime)) is bundled at build time by [`build/test-runtime.ts`](../build/test-runtime.ts).
6. **Container tests** asks the `TestBox` Durable Object to start a container, which clones, installs, runs vitest and the commands, and reports progress back until it ends.

## Webhook events

| Event | Actions |
| --- | --- |
| `pull_request` | `opened`, `reopened`, `edited`, `synchronize`, `labeled`, `unlabeled`, `ready_for_review` |
| `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | all (only for checks that ask for them, such as Codex review) |
| `issue_comment` | all, on pull requests (same; also `/quality-flare run`) |
| `check_run` | `rerequested` (the **Re-run** button; runs only that check), `completed` (Tests and Container tests of this App: updates the status comment) |
| `check_suite` | `rerequested` (runs every check) |

## Routes

| Path | What it serves |
| --- | --- |
| `POST /` | GitHub webhooks |
| `GET /` | The home page on the project's own instance; elsewhere a redirect to `/admin` (or `/setup` until it is finished) |
| `/docs` | This documentation, rendered from [`docs/`](../docs) at build time |
| `/setup` | Setup of a new installation; creates the GitHub App |
| `/admin` | The admin, behind Cloudflare Access |
| `/turbo` | Remote cache for container runs (Turborepo and tool caches), with a token per repository |

## Development

```sh
pnpm install
pnpm test        # tests (vitest, in Node)
pnpm typecheck   # Worker types + tsc
pnpm dev         # local server (cf dev)
```

The docs are Markdown files in [`docs/`](../docs); [`build/docs.ts`](../build/docs.ts) renders them and lists their order. Links between pages are written as `checks.md#tests`, so they work on GitHub too.
