import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import type { TestShard } from "./src/checks/tests/jobs.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// This deployment's account and resource IDs stay out of the repository: Workers Builds sets them as build
// variables (see README). Each one is optional when deploying, so a new installation deploys with none: the deploy
// creates the KV namespace, the D1 database, the R2 bucket and the Queue (and, once the Worker exists, keeps
// using the ones it is bound to), and /setup says what else to set. Elsewhere (types, dev, tests) a placeholder
// stands in, so the Worker's types always carry every binding.
// This file runs in Node; tsconfig checks it without Node's types.
declare const process: { argv: string[]; env: Record<string, string | undefined> };

// `cf deploy` builds in a child process without "deploy" in its arguments; scripts/deploy.mjs sets QF_DEPLOY for it.
const deploying = (Boolean(process.env.WORKERS_CI || process.env.QF_DEPLOY) || process.argv.includes("deploy")) && !process.argv.includes("types");
function fromEnv(name: string): string | undefined {
	return process.env[name] || (deploying ? undefined : `<${name}>`);
}
const kvId = fromEnv("SETTINGS_KV_ID");
const d1Id = fromEnv("RUNS_D1_ID");
const secretsStoreId = fromEnv("SECRETS_STORE_ID");
const accountId = fromEnv("CLOUDFLARE_ACCOUNT_ID");
// Set by scripts/deploy.mjs when the account has no Workers Paid plan: Containers, Dynamic Workers and a CPU limit
// above the default are Paid-only, so the deploy leaves out the two Tests checks and everything they need.
const noTests = process.env.QF_NO_TESTS === "1";
// When the daily full run starts (src/checks/tests/daily.ts), as a cron expression in UTC. The build variable
// DAILY_RUN_CRON changes it.
const dailyCron = process.env.DAILY_RUN_CRON || "0 9 * * *";

// The Tests check's "Container" runner (src/checks/tests/container.ts): one container per run,
// started by the TestBox Durable Object, which picks the instance type.
const testBox = defineContainer({
	name: "quality-flare-tests",
	schedulingPolicy: "durable-object",
	images: { tests: { dockerfile: "./containers/tests/Dockerfile", buildContext: "./containers/tests" } },
	observability: { enabled: true },
});

export default defineConfig({
	containers: noTests ? [] : [testBox],
	worker: {
		name: "quality-flare",
		compatibilityDate: "2026-10-06",
		entrypoint,
		// Keep Workers Logs on; deploys from this config would otherwise turn them off.
		observability: { enabled: true },
		// The webhook and admin are served on quality-flare.<subdomain>.workers.dev, unless the build variable
		// WORKERS_DEV is "false": an installation on its own domain turns that address off once the App's
		// Webhook URL points to the domain (see README).
		workersDev: process.env.WORKERS_DEV !== "false",
		// Each Tests shard builds its files' module graph (TypeScript stripping and all) before running it.
		...(noTests ? {} : { limits: { cpuMs: 120_000 } }),
		triggers: [
			// Tests shards, one per invocation. Concurrent invocations share an isolate's 128 MB, and each
			// holds its shard's code (up to SHARD_BYTES, ~32 MB), so raising maxConcurrency makes shards run
			// out of memory. Retries split a shard that crashed.
			triggers.queue({ name: "quality-flare-tests", maxBatchSize: 1, maxRetries: 3, maxConcurrency: 2 }),
			// Fails Tests runs past their deadline without waiting for their queued shards (SWEEP_CRON in src/index.ts).
			triggers.scheduled({ schedule: "*/5 * * * *" }),
			// The daily full run on default branches (src/checks/tests/daily.ts).
			triggers.scheduled({ schedule: dailyCron }),
		],
		exports: {
			// Relays live test progress to the admin over WebSockets.
			RunsHub: exports.durableObject({ storage: "sqlite" }),
			// Runs one Container tests run in a container (src/checks/tests/container.ts). Reached through
			// `exports` from cloudflare:workers, not a binding: a container's Durable Object can't be bound with a
			// Worker name, which bindings.durableObject always sets.
			// Without Workers Paid it stays declared, without its container: a namespace an earlier deploy created
			// can't just disappear from the exports.
			TestBox: exports.durableObject(noTests ? { storage: "sqlite" } : { storage: "sqlite", container: testBox }),
		},
		env: {
			// GitHub App ID (or Client ID), used as the JWT issuer.
			GITHUB_APP_ID: bindings.secret(),
			// The App's private key, PEM. PKCS#1 (as GitHub downloads it) or PKCS#8.
			GITHUB_PRIVATE_KEY: bindings.secret(),
			// The webhook secret configured on the GitHub App.
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
			// Where people open the admin; check runs link to their run there.
			// Empty until set: /setup shows the value.
			PUBLIC_URL: bindings.text(fromEnv("PUBLIC_URL") ?? ""),
			// Label that exempts a PR from the "Closes an issue" check.
			NO_ISSUE_LABEL: bindings.text("no-issue"),
			// Per-repository check settings, edited in the admin UI.
			SETTINGS: bindings.kv(kvId ? { id: kvId } : {}),
			// History of Tests check runs, shown in the admin.
			RUNS: bindings.d1(d1Id ? { id: d1Id } : { name: "quality-flare-runs" }),
			// Turborepo artifacts of Container tests runs (src/turbo-cache.ts); a lifecycle rule expires them.
			TURBO_CACHE: bindings.r2({ name: "quality-flare-turbo-cache" }),
			// The RunsHub Durable Object (see exports).
			LIVE: bindings.durableObject({ worker: "quality-flare", exportName: "RunsHub" }),
			// Loads Dynamic Workers that run each repository's tests (the "Tests" check).
			...(noTests ? {} : { LOADER: bindings.workerLoader() }),
			// "free-plan" when the deploy left the Tests checks out (see noTests); the Worker then hides them.
			TESTS_OFF: bindings.text(noTests ? "free-plan" : ""),
			// Shards of Tests runs, consumed by this same Worker (see triggers).
			TESTS_QUEUE: bindings.queue<TestShard>({ name: "quality-flare-tests" }),
			// API token with Account Analytics: Read, for the admin's real account usage (src/account-usage.ts), and the
			// account whose usage the admin shows. Optional: without them the costs page shows only the estimates.
			...(secretsStoreId && accountId
				? {
						ANALYTICS_TOKEN: bindings.secretsStoreSecret({ storeId: secretsStoreId, secretName: "quality-flare-analytics-token" }),
						CLOUDFLARE_ACCOUNT_ID: bindings.text(accountId),
					}
				: {}),
			// Audience tag of the Cloudflare Access application that protects /admin.
			// Empty until set, which keeps the admin closed.
			ACCESS_AUD: bindings.text(fromEnv("ACCESS_AUD") ?? ""),
		},
	},
});
