// `cf deploy` for installations that keep the GitHub App's secrets as Workers Builds build secrets
// (see README, "Instale o seu"). Arguments pass through to `cf deploy`.
//
// - The App's secrets found in the environment go up with the deploy (`--secrets-file`).
// - A new Worker can't deploy without its secrets, and the App can't exist before the Worker's address does:
//   on that error, the missing ones deploy as a placeholder, which the Worker reads as "not set up yet"
//   (src/setup.ts) until /setup has created the App and its secrets are set.
//
// Without any of these variables, and on a Worker that already exists, this is plain `cf deploy`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRETS = ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
// Same as PENDING in src/setup.ts.
const PENDING = "setup-pending";
const MISSING_SECRETS = "required secrets have not been set";

const args = process.argv.slice(2);
const given = Object.fromEntries(SECRETS.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));

let result = await deploy(given);
if (result.code !== 0 && result.output.includes(MISSING_SECRETS)) {
	console.log(`\nFirst deploy: the App's missing secrets go up as "${PENDING}". Finish at <your Worker's address>/setup.\n`);
	result = await deploy({ ...Object.fromEntries(SECRETS.map((name) => [name, PENDING])), ...given });
}
process.exit(result.code);

/** Runs `cf deploy`, showing its output as it comes and keeping it to look for the missing-secrets error. */
async function deploy(secrets) {
	const dir = mkdtempSync(join(tmpdir(), "qf-secrets-"));
	try {
		const file = join(dir, "secrets.json");
		const extra = Object.keys(secrets).length ? ["--secrets-file", file] : [];
		if (extra.length) writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
		const child = spawn("pnpm", ["exec", "cf", "deploy", ...extra, ...args], { stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, QF_DEPLOY: "1" } });
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
			process.stderr.write(chunk);
		});
		const code = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
		return { code, output };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
