import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import type { TestShard } from "./src/checks/tests/jobs.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The Tests check's "Container" runner (src/checks/tests/container.ts): one container per run,
// started by the TestBox Durable Object, which picks the instance type.
const testBox = defineContainer({
	name: "quality-flare-tests",
	schedulingPolicy: "durable-object",
	images: { tests: { dockerfile: "./containers/tests/Dockerfile", buildContext: "./containers/tests" } },
	observability: { enabled: true },
});

export default defineConfig({
	containers: [testBox],
	worker: {
		name: "quality-flare",
		compatibilityDate: "2026-10-06",
		entrypoint,
		// Keep Workers Logs on; deploys from this config would otherwise turn them off.
		observability: { enabled: true },
		// The webhook and admin are served on quality-flare.<subdomain>.workers.dev.
		workersDev: true,
		// Each Tests shard builds its files' module graph (TypeScript stripping and all) before running it.
		limits: { cpuMs: 120_000 },
		triggers: [
			// Tests shards, one per invocation. Concurrent invocations share an isolate's 128 MB, and each
			// holds its shard's code (up to SHARD_BYTES, ~32 MB), so raising maxConcurrency makes shards run
			// out of memory. Retries split a shard that crashed.
			triggers.queue({ name: "quality-flare-tests", maxBatchSize: 1, maxRetries: 3, maxConcurrency: 2 }),
			// Fails Tests runs past their deadline without waiting for their queued shards.
			triggers.scheduled({ schedule: "*/5 * * * *" }),
		],
		exports: {
			// Relays live test progress to the admin over WebSockets.
			RunsHub: exports.durableObject({ storage: "sqlite" }),
			// Runs one Container tests run in a container (src/checks/tests/container.ts). Reached through
			// `exports` from cloudflare:workers, not a binding: a container's Durable Object can't be bound with a
			// Worker name, which bindings.durableObject always sets.
			TestBox: exports.durableObject({ storage: "sqlite", container: testBox }),
		},
		env: {
			// GitHub App ID (or Client ID), used as the JWT issuer.
			GITHUB_APP_ID: bindings.secret(),
			// The App's private key, PEM. PKCS#1 (as GitHub downloads it) or PKCS#8.
			GITHUB_PRIVATE_KEY: bindings.secret(),
			// The webhook secret configured on the GitHub App.
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
			// Where people open the admin; check runs link to their run there.
			PUBLIC_URL: bindings.text("https://quality-flare.frega.dev"),
			// Label that exempts a PR from the "Closes an issue" check.
			NO_ISSUE_LABEL: bindings.text("no-issue"),
			// Per-repository check settings, edited in the admin UI.
			SETTINGS: bindings.kv({ id: "a5795e2f7f424adb8edb5576967d0087" }),
			// History of Tests check runs, shown in the admin.
			RUNS: bindings.d1({ id: "f30a90b8-1c92-44b0-9fe2-dcc87418b046" }),
			// The RunsHub Durable Object (see exports).
			LIVE: bindings.durableObject({ worker: "quality-flare", exportName: "RunsHub" }),
			// Loads Dynamic Workers that run each repository's tests (the "Tests" check).
			LOADER: bindings.workerLoader(),
			// Shards of Tests runs, consumed by this same Worker (see triggers).
			TESTS_QUEUE: bindings.queue<TestShard>({ name: "quality-flare-tests" }),
			// API token with Account Analytics: Read, for the admin's real account usage (src/account-usage.ts).
			ANALYTICS_TOKEN: bindings.secretsStoreSecret({ storeId: "85fcda41135f46eca687febcae69ca34", secretName: "quality-flare-analytics-token" }),
			// The account whose usage the admin shows.
			CLOUDFLARE_ACCOUNT_ID: bindings.text("abd87961a304b923acbc329f0b0d1919"),
			// Audience tag of the Cloudflare Access application that protects /admin.
			ACCESS_AUD: bindings.text("b04a2d0ead7c4054e2cf3ea58e43a1bcd1f9f276aa944fec5cb9c2f11f577bae"),
		},
	},
});
