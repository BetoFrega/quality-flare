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
		},
	},
});
