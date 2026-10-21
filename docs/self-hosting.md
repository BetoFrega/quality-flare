# Self-hosting

Anyone can run their own quality-flare, in their own Cloudflare account and with their own GitHub App. Nothing is installed on your computer: the build runs on [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

**You need** a Cloudflare account and a GitHub account. The free plan is enough for everything except the tests; see [Workers Free or Workers Paid](#workers-free-or-workers-paid).

## Workers Free or Workers Paid

| | Workers Free | Workers Paid (US$5/month) |
| --- | --- | --- |
| Closes an issue, Codex review, Dependabot auto-merge | ✅ | ✅ |
| Admin, `/setup`, these docs | ✅ | ✅ |
| [Tests](checks.md#tests) and [Container tests](checks.md#container-tests) | ❌ | ✅ |

The two Tests checks run on [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/) and [Containers](https://developers.cloudflare.com/containers/), which Cloudflare offers only on Workers Paid. You choose nothing: on a free account Cloudflare refuses the full deploy, and `pnpm run deploy` deploys again without the two checks, saying so in the build log. They don't appear in the admin, and the admin and `/setup` explain why.

To turn them on later, subscribe to [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and build again (**Deployments → Retry build**, or a push to `main`): the full deploy now goes through.

On Workers Paid, if the deploy's API token can't use Containers, the build fails and says to give the token the **Containers Edit** permission, instead of deploying without the tests.

The free plan has its own limits, such as 10 ms of CPU per request and 100,000 requests a day ([limits](https://developers.cloudflare.com/workers/platform/limits/)). The other checks mostly wait on GitHub, which doesn't count as CPU.

## Install

1. **Fork** [the repository](https://github.com/BetoFrega/quality-flare).
2. **Connect the fork to Cloudflare.** In [Workers & Pages → Create → Import a repository](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create), pick the fork and use:
   - **Project name:** `quality-flare`, the Worker name in `cloudflare.config.ts`
   - **Build command:** `pnpm typecheck && pnpm test`
   - **Deploy command:** `pnpm run deploy`

   The first deploy creates the KV namespace, the D1 database, the R2 bucket and the Queue on its own. The Worker starts without a GitHub App: until it has one, it refuses webhooks and sends visitors to `/setup`.
3. **Open `https://quality-flare.<your-subdomain>.workers.dev/setup`.** The page lists what is missing and walks you through it:
   - **Create the GitHub App.** One click creates the App on GitHub, on your account or an organization, with the right permissions, events and webhook. When GitHub sends you back, the page shows `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET` and `GITHUB_PRIVATE_KEY` once; add all three as **Secret** under the Worker's Settings → Build → Variables and secrets.
   - **`PUBLIC_URL`.** The page shows the value (this address, or your own domain); add it as a build variable.
   - **Admin sign-in.** Create a self-hosted Cloudflare Access application for `/admin` and `/admin/*` with a policy that allows your email, and copy its Audience (AUD) tag to the build variable `ACCESS_AUD`. Until then the admin stays closed.

   After changing build variables or secrets, build again (**Deployments → Retry build**, or a push to `main`).
4. **Install the App** on your repositories (the link is on `/setup` and in the admin) and **enable them** in `/admin`. Everything starts disabled.

Every push to your fork's `main` deploys again. `pnpm run deploy` ([`scripts/deploy.mjs`](../scripts/deploy.mjs)) is `cf deploy` plus the App's secrets kept in the build, and without the Tests checks on a free account; on Workers Paid and without those secrets it is plain `cf deploy`.

## Build variables

They live under the Worker's Settings → Build → Variables and secrets. [`cloudflare.config.ts`](../cloudflare.config.ts) reads the account and resource IDs from them, so none are kept in the repository. All are optional for the deploy, and `/setup` says which are still missing.

| Variable | What it is | Without it |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | The GitHub App's secrets, created on `/setup` | The Worker refuses webhooks and waits for the App |
| `PUBLIC_URL` | Where the admin is opened (check run links; the container uses it for caches) | Broken links |
| `ACCESS_AUD` | Audience (AUD) of the Cloudflare Access application that protects `/admin` | The admin stays closed |
| `WORKERS_DEV` | `false` turns the `workers.dev` address off (only with your own domain in the Webhook URL) | `workers.dev` stays on |
| `SETTINGS_KV_ID` | ID of the KV namespace with the settings | The deploy creates one, or keeps the one the Worker already uses |
| `RUNS_D1_ID` | ID of the D1 database with run history | The deploy uses (or creates) the D1 database `quality-flare-runs` |
| `SECRETS_STORE_ID`, `CLOUDFLARE_ACCOUNT_ID` | Secrets Store holding `quality-flare-analytics-token`, and the account whose usage the admin shows | `/admin/costs` shows estimates only |

Outside Workers Builds (`cf dev`, `pnpm typecheck`, tests), anything missing becomes a placeholder.

## Optional

- **Container tests cache.** The R2 bucket `quality-flare-turbo-cache` keeps run caches. To keep it from growing forever, delete objects older than 14 days:

  ```sh
  cf r2 buckets lifecycle update quality-flare-turbo-cache -f --rules '[{"id":"expire-14-days","enabled":true,"conditions":{"prefix":""},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":1209600}}}]'
  ```

- **Real account usage in the admin** ([costs](admin.md#costs)). Create an API token with *Account Analytics: Read*, store it in Secrets Store as `quality-flare-analytics-token`, and set the build variables `SECRETS_STORE_ID` and `CLOUDFLARE_ACCOUNT_ID`.
- **Your own domain.** Add a Custom Domain to the Worker, and use it in `PUBLIC_URL`, in the Access application and in the App's Webhook URL (Settings → Developer settings → GitHub Apps → your App → Webhook URL). To turn the `workers.dev` address off after that, set the build variable `WORKERS_DEV` to `false`; doing so before changing the Webhook URL stops the webhooks. Turning `workers.dev` off only in the dashboard doesn't last: the next deploy turns it back on.

## Require the checks

In each repository, under **Settings → Rules** (or Branch protection), require the status checks that should block merging, such as **Closes an issue** or **Container tests**.

## GitHub App permissions

The App created on `/setup` already has these. To create one by hand, under **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL:** the Worker's address. **Webhook secret:** a random value, the same as `GITHUB_WEBHOOK_SECRET`.
- **Repository permissions:** Checks, Contents, Pull requests and Issues as **Read and write** (Tests downloads the pull request's code, Dependabot auto-merge merges, the status comment goes on the pull request, the daily full run opens an issue when it fails), and Metadata **Read-only**.
- **Events:** Pull request, Check run, Check suite, Pull request review, Pull request review comment, Pull request review thread, Issue comment.

## Deploy from your computer

You need Docker for the container image:

```sh
pnpm install
pnpm exec cf auth login          # or CLOUDFLARE_API_TOKEN
pnpm run deploy                  # with the build variables above in the environment, if you have them
```

For `cf dev`, put `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` in a `.dev.vars` file.

## Things to avoid

- Don't change the Worker's code through the Cloudflare API or dashboard. `cf deploy` in CI refuses to publish a Worker that was changed outside it; a single `wrangler deploy` unblocks it.
- The **Cloudflare Workers and Pages** GitHub app needs access to your fork (GitHub Settings → Applications → Configure → Repository access). Without it, Cloudflare doesn't get your pushes and no build starts.
