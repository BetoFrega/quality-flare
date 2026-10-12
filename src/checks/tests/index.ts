import type { GitHubClient } from "../../github.ts";
import { d1RunStore } from "../../runs.ts";
import type { Check, CheckResult } from "../types.ts";
import { isLoadable } from "./convention.ts";
import { readLockfile, type LockedPackage } from "./lockfile.ts";
import { buildModules, MAIN_MODULE, type TestBundle } from "./modules.ts";
import { toCheckResult, type TestReport } from "./report.ts";
import { readTarball } from "./tarball.ts";

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);
const PACKAGE_FILE = /\.(c|m)?js$|\.json$/;

/** Runtime the tests run on: today's Workers, with Node.js APIs. */
const COMPATIBILITY_DATE = "2026-10-06";

/** Code only changes on these; label and description edits don't need a new test run. */
const CODE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * Runs the repository's `*.test.*` / `*.spec.*` files at the PR head in a Dynamic Worker,
 * with vitest's runner and `expect`, and records each run for the admin. The convention is in
 * the README and in .claude/skills/quality-flare-tests/SKILL.md.
 */
export const tests: Check = {
	id: "tests",
	name: "Tests",
	pullRequestActions: CODE_ACTIONS,
	async run({ github, repo, pr, env }) {
		const runs = d1RunStore(env.RUNS);
		// The history is for visibility only; failing to record must not fail the check.
		const runId = await runs.start({ repo, pr: pr.number, sha: pr.head.sha }).catch(logError);
		const { result, report } = await runTests(github, repo, pr.head.sha, env.LOADER);
		if (runId !== undefined) await runs.finish(runId, result, report).catch(logError);
		return result;
	},
};

async function runTests(
	github: GitHubClient,
	repo: string,
	sha: string,
	loader: WorkerLoader,
): Promise<{ result: CheckResult; report?: TestReport }> {
	try {
		const files = await readTarball(await github.getTarball(repo, sha), (p) => isLoadable(p) || LOCKFILES.has(p));
		// Imported lazily: the bundled runtime is only needed when the check actually runs.
		const { default: runtimeSource } = await import("virtual:test-runtime");
		const bundle = await buildModules(files, { runtimeSource, lockfile: readLockfile(files), fetchPackage });
		if (!bundle.testFiles.length) return { result: NO_TESTS };
		const report = await runInDynamicWorker(loader, bundle);
		return { result: toCheckResult(report, bundle.unresolved), report };
	} catch (error) {
		return {
			result: {
				conclusion: "failure",
				title: "Não foi possível rodar os testes",
				summary: `\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
			},
		};
	}
}

function logError(error: unknown): undefined {
	console.error("quality-flare: could not record the test run", error);
	return undefined;
}

const NO_TESTS: CheckResult = {
	conclusion: "neutral",
	title: "Nenhum teste encontrado",
	summary: "Nenhum arquivo `*.test.ts`, `*.test.js`, `*.spec.ts` ou `*.spec.js` (nem `.mts`/`.mjs`) fora de `node_modules`, `dist`, `build`, `coverage` e pastas ocultas.",
};

/** Downloads a package from the npm registry. */
async function fetchPackage({ name, version }: LockedPackage): Promise<Map<string, string>> {
	const res = await fetch(`https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`);
	if (!res.ok || !res.body) throw new Error(`npm: ${name}@${version} → ${res.status}`);
	return readTarball(res.body, (p) => PACKAGE_FILE.test(p));
}

/** Loads the bundle as a fresh Dynamic Worker without network access and runs every test file. */
export async function runInDynamicWorker(loader: WorkerLoader, bundle: TestBundle): Promise<TestReport> {
	const worker = loader.load({
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		mainModule: MAIN_MODULE,
		modules: bundle.modules,
		globalOutbound: null,
		limits: { cpuMs: 30_000 },
	});
	const res = await worker.getEntrypoint().fetch("http://tests/", { method: "POST", body: JSON.stringify(bundle.testFiles) });
	if (!res.ok) throw new Error(`O Dynamic Worker respondeu ${res.status}: ${await res.text()}`);
	return res.json();
}
