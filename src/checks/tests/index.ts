import { GitHubClient } from "../../github.ts";
import { livePublisher } from "../../live.ts";
import { d1RunStore } from "../../runs.ts";
import type { Check, CheckResult } from "../types.ts";
import { CONFIG_FILE, readTestConfig, selectTestFiles, type TestConfig } from "./config.ts";
import { readVitestConfig } from "./vitest-config.ts";
import { isAsset, isLoadable, isTestFile } from "./convention.ts";
import { d1JobStore, type JobStore, type ShardResult, type TestShard } from "./jobs.ts";
import { readLockfile, type LockedPackage } from "./lockfile.ts";
import { buildModules, bundleSize, MAIN_MODULE, type TestBundle } from "./modules.ts";
import { type PackageFiles, readPackage, type Turns, turns } from "./packages.ts";
import { mergeReports, toCheckResult, type ProgressEvent, type RunRequest, type TestReport } from "./report.ts";
import { readRun } from "./stream.ts";
import { readTarball } from "./tarball.ts";

const NAME = "Tests";
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);
// Stylesheets are read with node:fs by some packages (jsdom's default stylesheet), never imported.
const PACKAGE_FILE = /\.(c|m)?js$|\.json$|\.css$/;

/** Runtime the tests run on: today's Workers, with Node.js APIs. */
const COMPATIBILITY_DATE = "2026-10-06";

/** Code only changes on these; label and description edits don't need a new test run. */
const CODE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * Test files per shard. Kept small because the Worker that builds a shard has 128 MB, and a shard
 * that runs out of it crashes and retries in halves; building a shard costs about the same for 1
 * file as for 5. A shard whose code is too big splits in two until it fits.
 */
export const SHARD_SIZE = 5;

/** A Dynamic Worker takes at most 64 MB of code; past this, a shard splits instead of trying. */
export const MAX_CODE_BYTES = 48 * 1024 * 1024;

/**
 * A run that hasn't finished this long after it started stops: its shards still queued report
 * their files as failed without running them, so the run completes instead of using the queue.
 */
export const RUN_DEADLINE_MS = 60 * 60_000;

/** A one-file shard that crashed the consumer this many times (out of memory, likely) is reported as failed. */
const MAX_ATTEMPTS = 3;

/**
 * Runs the repository's `*.test.*` / `*.spec.*` files at the PR head in Dynamic Workers, with
 * vitest's runner and `expect`. The webhook only lists the test files and queues them in
 * shards; each shard builds and runs its own files from the queue (`runTestShards`), and the
 * last one to finish reports the check run. The convention is in the README and in
 * .claude/skills/quality-flare-tests/SKILL.md.
 */
export const tests: Check = {
	id: "tests",
	name: NAME,
	pullRequestActions: CODE_ACTIONS,
	async run({ github, repo, pr, env, installationId }) {
		const sha = pr.head.sha;
		const runs = d1RunStore(env.RUNS);
		// History and live progress are for visibility only; failing to record must not fail the check.
		const runId = await runs.start({ repo, pr: pr.number, sha }).catch(logError);
		const live = livePublisher(runId === undefined ? undefined : env.LIVE);
		live.send({ type: "started", runId: runId!, repo, pr: pr.number, sha });
		let checkRunId: number | undefined;
		try {
			if (runId === undefined) throw new Error("O D1 (quality-flare-runs) não respondeu; ele coordena os lotes de testes.");
			// A newer push supersedes the PR's runs still going: their queued shards drop themselves.
			await cancelRuns(github, repo, await runs.running(repo, pr.number, runId), d1JobStore(env.RUNS), runs, live);
			const read = (path: string) => github.getFileText(repo, sha, path);
			// quality-flare.json overrides, key by key, what the repository's vitest config says.
			const config = { ...(await readVitestConfig(read)).config, ...readTestConfig(await read(CONFIG_FILE)) };
			const testFiles = selectTestFiles(await github.listFiles(repo, sha), config, isTestFile).sort();
			if (!testFiles.length) {
				await finishRun(runs, live, runId, NO_TESTS);
				return NO_TESTS;
			}
			const shards = chunk(testFiles, SHARD_SIZE).map(
				(files, i): TestShard => ({ runId, shard: String(i), repo, installationId, sha, files, config }),
			);
			const title = `Rodando ${count(testFiles.length, "arquivo")} de teste`;
			checkRunId = await github.startCheckRun(repo, sha, NAME, title, `${env.PUBLIC_URL}/admin/runs/${runId}`);
			await d1JobStore(env.RUNS).create(runId, { shards: shards.length, checkRunId, installationId });
			await enqueue(env.TESTS_QUEUE, shards);
			live.send({ type: "status", runId, text: `${count(testFiles.length, "arquivo")} de teste na fila, em ${count(shards.length, "lote")}` });
			await live.flush();
			return null;
		} catch (error) {
			const result = cannotRun(error);
			if (runId !== undefined) await finishRun(runs, live, runId, result);
			if (checkRunId === undefined) return result;
			await github.completeCheckRun(repo, checkRunId, result);
			return null;
		}
	},
};

/** Queue consumer: runs each shard, and publishes the run when its last shard is done. */
export async function runTestShards(batch: MessageBatch<TestShard>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const shard = message.body;
		const live = livePublisher(env.LIVE);
		const credentials = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY };
		const github = () => GitHubClient.forInstallation(credentials, shard.installationId);
		try {
			await processShard(shard, message.attempts, {
				jobs: d1JobStore(env.RUNS),
				enqueue: (shards) => enqueue(env.TESTS_QUEUE, shards),
				run: async (s) => runShard(await github(), env.LOADER, s, (event) => live.send({ runId: s.runId, ...event })),
				publish: async (s, report, unresolved) => {
					const job = await d1JobStore(env.RUNS).get(s.runId);
					const result = report.files.length ? toCheckResult(report, unresolved) : NO_TESTS;
					if (job) await (await github()).completeCheckRun(s.repo, job.checkRunId, result);
					await finishRun(d1RunStore(env.RUNS), live, s.runId, result, report);
				},
			});
			await live.flush();
			message.ack();
		} catch (error) {
			console.error("quality-flare: test shard failed, retrying", shard.runId, shard.shard, error);
			message.retry();
		}
	}
}

export interface ShardDeps {
	jobs: JobStore;
	enqueue(shards: TestShard[]): Promise<void>;
	run(shard: TestShard): Promise<ShardResult>;
	/** Epoch milliseconds; Date.now() when absent. */
	now?(): number;
	publish(shard: TestShard, report: TestReport, unresolved: ShardResult["unresolved"]): Promise<void>;
}

/** Runs one shard, splitting it when it doesn't fit, and publishes the run if it was the last. */
export async function processShard(shard: TestShard, attempts: number, deps: ShardDeps): Promise<void> {
	// The run was cancelled by a newer push: nothing to run or report.
	const job = await deps.jobs.get(shard.runId);
	if (!job) return;
	const expired = job.startedAt !== undefined && (deps.now?.() ?? Date.now()) - job.startedAt > RUN_DEADLINE_MS;
	// A shard that took the consumer down before (out of memory, most likely) tries again in halves.
	if (!expired && attempts > 1 && shard.files.length > 1) return split(shard, deps);
	let result: ShardResult;
	if (expired) {
		result = failed(shard.files, `A execução passou de ${RUN_DEADLINE_MS / 60_000} minutos e parou antes de chegar a este arquivo.`);
	} else if (attempts >= MAX_ATTEMPTS) {
		result = failed(shard.files, `O arquivo derrubou o Worker ${attempts - 1} vezes (provavelmente faltou memória: o limite é 128 MB).`);
	} else {
		try {
			result = await deps.run(shard);
		} catch (error) {
			// Too big, or one file took the Dynamic Worker down: halve until the culprit runs alone.
			if ((error instanceof TooLarge || error instanceof Crashed) && shard.files.length > 1) return split(shard, deps);
			result = failed(shard.files, error instanceof Error ? error.message : String(error));
		}
	}
	const all = await deps.jobs.finish(shard.runId, shard.shard, result);
	if (all) {
		const { report, unresolved } = mergeReports(all);
		await deps.publish(shard, report, unresolved);
	}
}

async function split(shard: TestShard, deps: ShardDeps): Promise<void> {
	const half = Math.ceil(shard.files.length / 2);
	await deps.jobs.split(shard.runId, shard.shard, 2);
	// Enqueued even when this split was recorded before: the halves' results count once anyway.
	await deps.enqueue([
		{ ...shard, shard: `${shard.shard}.0`, files: shard.files.slice(0, half) },
		{ ...shard, shard: `${shard.shard}.1`, files: shard.files.slice(half) },
	]);
}

/** Thrown when a shard's code doesn't fit in one Dynamic Worker. */
export class TooLarge extends Error {
	constructor(bytes: number) {
		super(`Os testes importam ${(bytes / 1024 / 1024).toFixed(0)} MB de código; um Dynamic Worker aceita até 64 MB.`);
	}
}

/** Thrown when the Dynamic Worker died while running a shard's files. */
export class Crashed extends Error {
	constructor(cause: unknown) {
		super(`O Dynamic Worker caiu ao rodar este arquivo: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

/** Builds a shard's files and everything they import, and runs them in a fresh Dynamic Worker. */
async function runShard(
	github: GitHubClient,
	loader: WorkerLoader,
	shard: TestShard,
	onProgress: (event: ProgressEvent) => void,
): Promise<ShardResult> {
	const label = `Lote ${shard.shard}`;
	onProgress({ type: "status", text: `${label}: baixando o código` });
	const files = await readTarball(await github.getTarball(shard.repo, shard.sha), (p, size) => isLoadable(p) || LOCKFILES.has(p) || isAsset(p, size));
	onProgress({ type: "status", text: `${label}: montando ${count(shard.files.length, "arquivo")} de teste e as dependências` });
	// Imported lazily: the bundled runtime is only needed when tests actually run.
	const { default: runtimeSource } = await import("virtual:test-runtime");
	const inTurn = turns();
	const lockfile = readLockfile(files);
	// vitest 5 clears every mock's calls before each test unless the config says otherwise.
	const vitest = lockfile?.fromRepo("package.json", "vitest")?.version;
	const config = { ...shard.config, clearMocks: shard.config?.clearMocks ?? Number(vitest?.split(".")[0]) >= 5 };
	const bundle = await buildModules(files, {
		runtimeSource,
		lockfile,
		fetchPackage: (pkg) => fetchPackage(pkg, inTurn),
		testFiles: shard.files,
		setupFiles: shard.config?.setupFiles,
		environment: shard.config?.environment,
	});
	files.clear();
	// Imports that fail inside npm packages are usually optional ones that never run.
	const unresolved = bundle.unresolved.filter((u) => !u.from.startsWith("node_modules/"));
	if (!bundle.testFiles.length) return { report: { files: [] }, unresolved };
	const size = bundleSize(bundle);
	if (size > MAX_CODE_BYTES) throw new TooLarge(size);
	onProgress({ type: "status", text: `${label}: rodando` });
	try {
		return { report: await runInDynamicWorker(loader, bundle, onProgress, config), unresolved };
	} catch (error) {
		if (error instanceof Error && /exceeds the maximum allowed size/.test(error.message)) throw new TooLarge(size);
		throw new Crashed(error);
	}
}

/** A shard's files, each failed with `message`. */
function failed(files: string[], message: string): ShardResult {
	return { report: { files: files.map((path) => ({ path, state: "fail", errors: [message], tests: [] })) }, unresolved: [] };
}

const CANCELLED: CheckResult = {
	conclusion: "cancelled",
	title: "Cancelada por um push mais novo",
	summary: "A PR recebeu commits novos enquanto os testes rodavam; os testes rodam de novo no commit novo.",
};

/** Completes the given runs as cancelled, in the history and on GitHub, and stops their shards. */
async function cancelRuns(
	github: GitHubClient,
	repo: string,
	runIds: number[],
	jobs: JobStore,
	runs: ReturnType<typeof d1RunStore>,
	live: ReturnType<typeof livePublisher>,
): Promise<void> {
	for (const id of runIds) {
		const job = await jobs.cancel(id);
		if (job) await github.completeCheckRun(repo, job.checkRunId, CANCELLED).catch(logError);
		await finishRun(runs, live, id, CANCELLED);
	}
}

async function finishRun(
	runs: ReturnType<typeof d1RunStore>,
	live: ReturnType<typeof livePublisher>,
	runId: number,
	result: CheckResult,
	report?: TestReport,
): Promise<void> {
	await runs.finish(runId, result, report).catch(logError);
	live.send({ type: "finished", runId, conclusion: result.conclusion, title: result.title });
	await live.flush();
}

async function enqueue(queue: Queue<TestShard>, shards: TestShard[]): Promise<void> {
	// sendBatch takes at most 100 messages.
	for (const part of chunk(shards, 100)) await queue.sendBatch(part.map((body) => ({ body })));
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function cannotRun(error: unknown): CheckResult {
	return {
		conclusion: "failure",
		title: "Não foi possível rodar os testes",
		summary: `\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
	};
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

/** Downloads a package from the npm registry. Tarballs never change, so Cloudflare's cache keeps them. */
function fetchPackage({ name, version }: LockedPackage, inTurn: Turns): Promise<PackageFiles> {
	return readPackage(async () => {
		const res = await fetch(`https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, {
			cf: { cacheEverything: true, cacheTtl: 7 * 24 * 3600 },
		});
		if (!res.ok || !res.body) throw new Error(`npm: ${name}@${version} → ${res.status}`);
		return res.body;
	}, (p) => PACKAGE_FILE.test(p), inTurn).catch((error: unknown) => {
		console.error("quality-flare: could not read npm package", `${name}@${version}`, error);
		throw error;
	});
}

/** Loads the bundle as a fresh Dynamic Worker without network access and runs every test file. */
export async function runInDynamicWorker(
	loader: WorkerLoader,
	bundle: TestBundle,
	onProgress: (event: ProgressEvent) => void = () => {},
	config: TestConfig = {},
): Promise<TestReport> {
	const worker = loader.load({
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		mainModule: MAIN_MODULE,
		modules: bundle.modules,
		globalOutbound: null,
		limits: { cpuMs: 30_000 },
	});
	const { globals, testTimeout, clearMocks, mockReset, restoreMocks } = config;
	const run: RunRequest = { files: bundle.testFiles, setupFiles: bundle.setupFiles, globals, testTimeout, clearMocks, mockReset, restoreMocks };
	const res = await worker.getEntrypoint().fetch("http://tests/", { method: "POST", body: JSON.stringify(run) });
	if (!res.ok) throw new Error(`O Dynamic Worker respondeu ${res.status}: ${await res.text()}`);
	return readRun(res, onProgress);
}
