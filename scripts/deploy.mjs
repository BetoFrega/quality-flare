// `cf deploy` for installations that keep the GitHub App's secrets as Workers Builds build secrets
// (see README, "Instale o seu"). Arguments pass through to `cf deploy`.
//
// - The App's secrets found in the environment go up with the deploy (`--secrets-file`).
// - A new Worker can't deploy without its secrets, and the App can't exist before the Worker's address does:
//   on that error, the missing ones deploy as a placeholder, which the Worker reads as "not set up yet"
//   (src/setup.ts) until /setup has created the App and its secrets are set.
// - Containers, Dynamic Workers and a CPU limit need Workers Paid. When Cloudflare refuses the deploy for the
//   account's plan, it deploys again without the two Tests checks (QF_NO_TESTS, see cloudflare.config.ts); the
//   next build after the account moves to Workers Paid deploys them again.
//
// Without any of these variables, on a Workers Paid account and on a Worker that already exists, this is plain `cf deploy`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRETS = ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
// Same as PENDING in src/setup.ts.
const PENDING = "setup-pending";
const MISSING_SECRETS = "required secrets have not been set";
/**
 * How Cloudflare refuses each Paid-only part on a Workers Free account: Dynamic Workers (10195), the CPU limit
 * (100328), and Containers, whose registry answers a Free account's token with a bare 403 on /containers/me.
 */
const FREE_PLAN = [/code"?:? ?10195\b/i, /code"?:? ?100328\b/i];
/** A token without the Containers permission gets the same 403 on a Workers Paid account. */
const CONTAINERS_403 = /\/containers\/me\b[\s\S]{0,400}\b(403|Forbidden|Authentication error)/;

const args = process.argv.slice(2);
const given = Object.fromEntries(SECRETS.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));

let secrets = given;
let noTests = false;
let result = await deploy(secrets, noTests);
for (;;) {
	if (result.code === 0) break;
	if (!noTests && (FREE_PLAN.some((error) => error.test(result.output)) || (CONTAINERS_403.test(result.output) && !(await containersEnabled())))) {
		noTests = true;
		console.log(
			"\n⚠️  This Cloudflare account has no Workers Paid plan, which the Tests and Container tests checks need: deploying without them." +
				"\n    The other checks, the admin and /setup work. After subscribing to Workers Paid, build again (Deployments → Retry build).\n",
		);
	} else if (secrets === given && result.output.includes(MISSING_SECRETS)) {
		console.log(`\nFirst deploy: the App's missing secrets go up as "${PENDING}". Finish at <your Worker's address>/setup.\n`);
		secrets = { ...Object.fromEntries(SECRETS.map((name) => [name, PENDING])), ...given };
	} else break;
	result = await deploy(secrets, noTests);
}
if (result.code !== 0 && !noTests && CONTAINERS_403.test(result.output)) {
	console.log(
		"\n⚠️  This account has Containers, but the deploy's API token can't use them. Give the token the Containers Edit permission" +
			" (Settings → Build → API token), or build again once it has it.\n",
	);
}
process.exit(result.code);

/**
 * Whether the account's plan includes Containers, from its entitlements (Account Settings Read, which the Workers
 * Builds token has). When it can't tell, the 403 is taken as the plan's, as before.
 */
async function containersEnabled() {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!account || !token) return false;
	try {
		const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/entitlements`, { headers: { Authorization: `Bearer ${token}` } });
		if (!res.ok) return false;
		const { result } = await res.json();
		return Array.isArray(result) && result.some((e) => e.id === "containers.enabled" && e.allocation?.value === true);
	} catch {
		return false;
	}
}

/** Runs `cf deploy`, showing its output as it comes and keeping it to look for the errors above. */
async function deploy(secrets, noTests) {
	const dir = mkdtempSync(join(tmpdir(), "qf-secrets-"));
	try {
		const file = join(dir, "secrets.json");
		const extra = Object.keys(secrets).length ? ["--secrets-file", file] : [];
		if (extra.length) writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
		const child = spawn("pnpm", ["exec", "cf", "deploy", ...extra, ...args], { stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, QF_DEPLOY: "1", ...(noTests ? { QF_NO_TESTS: "1" } : {}) } });
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
