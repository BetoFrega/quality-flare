import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "quality-flare",
		compatibilityDate: "2026-10-06",
		entrypoint,
		// Keep Workers Logs on; deploys from this config would otherwise turn them off.
		observability: { enabled: true },
		env: {
			// GitHub App ID (or Client ID), used as the JWT issuer.
			GITHUB_APP_ID: bindings.secret(),
			// The App's private key, PEM. PKCS#1 (as GitHub downloads it) or PKCS#8.
			GITHUB_PRIVATE_KEY: bindings.secret(),
			// The webhook secret configured on the GitHub App.
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
			// Label that exempts a PR from the "Closes an issue" check.
			NO_ISSUE_LABEL: bindings.text("no-issue"),
			// Per-repository check settings, edited in the admin UI.
			SETTINGS: bindings.kv({ id: "a5795e2f7f424adb8edb5576967d0087" }),
			// History of Tests check runs, shown in the admin.
			RUNS: bindings.d1({ id: "f30a90b8-1c92-44b0-9fe2-dcc87418b046" }),
			// Loads Dynamic Workers that run each repository's tests (the "Tests" check).
			LOADER: bindings.workerLoader(),
			// Audience tag of the Cloudflare Access application that protects /admin.
			ACCESS_AUD: bindings.text("b04a2d0ead7c4054e2cf3ea58e43a1bcd1f9f276aa944fec5cb9c2f11f577bae"),
		},
	},
});
