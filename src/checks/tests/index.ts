import { GitHubClient } from "../../github.ts";
import { livePublisher } from "../../live.ts";
import { d1MetricsStore, type ShardAttempt, type ShardOutcome } from "../../metrics.ts";
import { d1RunStore, type RunStore } from "../../runs.ts";
import type { Check, CheckResult } from "../types.ts";
import { CONFIG_FILE, readTestConfig, selectTestFiles, type TestConfig } from "./config.ts";
import { readVitestConfig } from "./vitest-config.ts";
import { isAsset, isLoadable, isTestFile } from "./convention.ts";
import { d1JobStore, type JobStore, type RunJob, type ShardResult, type TestShard } from "./jobs.ts";
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
 * Test files per shard. Files in one shard share a Dynamic Worker, and so the state of modules
 * they both import, which vitest would give each file fresh; more files per shard make that leak
 * between files more likely. A shard whose code is too big, or that takes the Worker down, splits
 * in two until it fits.
 */
export const SHARD_SIZE = 5;

/** A shard whose tests run this long (a test awaiting forever, mostly) stops and splits. */
export const SHARD_DEADLINE_MS = 5 * 60_000;

/** A Dynamic Worker takes at most 64 MB of code; past this, a shard splits instead of trying. */
export const MAX_CODE_BYTES = 48 * 1024 * 1024;

/**
 * A run that hasn't finished this long after it started stops. The cron sweep (`sweepOverdueRuns`)
 * fails it with the shards that finished and drops the rest from the queue; a shard that surfaces
 * before the sweep reports its files as failed without running them.
 */
export const RUN_DEADLINE_MS = 60 * 60_000;

/**
 * Files in one shard share the module state vitest gives each file fresh (React's pending
 * transitions, for one), so a file can fail only because of another. Up to this many files that
 * failed in a shard run again alone, and that result counts; past it, the shard's result stands.
 */
export const MAX_RECHECKS = 10;

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
export async function runTestShards(batch: MessageBatch<TestShard>, env: Env, ctx?: ExecutionContext): Promise<void> {
	for (const message of batch.messages) {
		const shard = message.body;
		const live = livePublisher(env.LIVE);
		const credentials = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY };
		const github = () => GitHubClient.forInstallation(credentials, shard.installationId);
		// What the attempt costs, for the admin; failing to record it must not fail the shard.
		const metrics = d1MetricsStore(env.RUNS);
		const attempt: ShardAttempt = { runId: shard.runId, shard: shard.shard, attempt: message.attempts };
		await metrics.start({ ...attempt, files: shard.files.length }).catch(logError);
		const meter: ShardMeter = { tails: ctx?.exports?.ShardTail ? [ctx.exports.ShardTail({ props: attempt })] : undefined };
		const record = (outcome: ShardOutcome) =>
			metrics.finish({ ...attempt, outcome, codeBytes: meter.codeBytes, dynamicWorker: Boolean(meter.loaded) }).catch(logError);
		try {
			const outcome = await processShard(shard, message.attempts, {
				jobs: d1JobStore(env.RUNS),
				enqueue: (shards) => enqueue(env.TESTS_QUEUE, shards),
				run: async (s) => runShard(await github(), env.LOADER, s, (event) => live.send({ runId: s.runId, ...event }), meter),
				publish: async (s, report, unresolved) => {
					const job = await d1JobStore(env.RUNS).get(s.runId);
					const result = report.files.length ? toCheckResult(report, unresolved) : NO_TESTS;
					if (job) await (await github()).completeCheckRun(s.repo, job.checkRunId, result);
					await finishRun(d1RunStore(env.RUNS), live, s.runId, result, report);
				},
			});
			await live.flush();
			await record(outcome);
			message.ack();
		} catch (error) {
			console.error("quality-flare: test shard failed, retrying", shard.runId, shard.shard, error);
			await record("error");
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

/** Runs one shard, splitting it when it doesn't fit, and publishes the run if it was the last. Says what it did. */
export async function processShard(shard: TestShard, attempts: number, deps: ShardDeps): Promise<ShardOutcome> {
	// The run was cancelled by a newer push: nothing to run or report.
	const job = await deps.jobs.get(shard.runId);
	if (!job) return "skipped";
	const expired = job.startedAt !== undefined && (deps.now?.() ?? Date.now()) - job.startedAt > RUN_DEADLINE_MS;
	// A shard that took the consumer down before (out of memory, most likely) tries again in halves.
	if (!expired && attempts > 1 && shard.files.length > 1) return split(shard, deps).then(() => "split");
	let result: ShardResult;
	let ran = false;
	let outcome: ShardOutcome;
	if (expired) {
		result = failed(shard.files, `A execução passou de ${RUN_DEADLINE_MS / 60_000} minutos e parou antes de chegar a este arquivo.`);
		outcome = "expired";
	} else if (attempts >= MAX_ATTEMPTS) {
		result = failed(shard.files, `O arquivo derrubou o Worker ${attempts - 1} vezes (provavelmente faltou memória: o limite é 128 MB).`);
		outcome = "gave-up";
	} else {
		try {
			result = await deps.run(shard);
			ran = true;
			outcome = "ran";
		} catch (error) {
			// Too big, or one file took the Dynamic Worker down: halve until the culprit runs alone.
			if ((error instanceof TooLarge || error instanceof Crashed) && shard.files.length > 1) {
				return split(shard, deps).then(() => (error instanceof TooLarge ? "too-large" : "crashed"));
			}
			result = failed(shard.files, error instanceof Error ? error.message : String(error));
			outcome = "failed";
		}
	}
	const recheck = ran && !shard.recheck && shard.files.length > 1 ? failedFiles(result) : [];
	if (recheck.length && recheck.length <= MAX_RECHECKS) return rerunAlone(shard, result, recheck, deps).then(() => "rechecked");
	await finish(shard, shard.shard, result, deps);
	return outcome;
}

async function finish(shard: TestShard, id: string, result: ShardResult, deps: ShardDeps): Promise<void> {
	const all = await deps.jobs.finish(shard.runId, id, result);
	if (all) {
		const { report, unresolved } = mergeReports(all);
		await deps.publish(shard, report, unresolved);
	}
}

export interface SweepDeps {
	runs: Pick<RunStore, "overdue" | "finish">;
	jobs: Pick<JobStore, "close">;
	now(): number;
	completeCheckRun(repo: string, job: RunJob, result: CheckResult): Promise<void>;
}

/** Cron: fails every run past RUN_DEADLINE_MS with what finished, so none waits on its queued shards. */
export async function sweepOverdueRuns(env: Env): Promise<void> {
	const credentials = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY };
	await expireRuns({
		runs: d1RunStore(env.RUNS),
		jobs: d1JobStore(env.RUNS),
		now: Date.now,
		async completeCheckRun(repo, job, result) {
			await (await GitHubClient.forInstallation(credentials, job.installationId)).completeCheckRun(repo, job.checkRunId, result);
		},
	});
}

export async function expireRuns(deps: SweepDeps): Promise<void> {
	for (const run of await deps.runs.overdue(deps.now() - RUN_DEADLINE_MS)) {
		// Closing drops the job, so the run's shards still queued skip their files and publish nothing.
		const job = await deps.jobs.close(run.id);
		const { report, unresolved } = mergeReports(job?.results ?? []);
		const result = overdue(report, unresolved);
		if (job) await deps.completeCheckRun(run.repo, job, result).catch(logError);
		await deps.runs.finish(run.id, result, report);
	}
}

function overdue(report: TestReport, unresolved: ShardResult["unresolved"]): CheckResult {
	const n = report.files.length;
	const done = `${count(n, "arquivo")} ${n === 1 ? "terminou" : "terminaram"} antes disso; os outros não rodaram.`;
	return {
		conclusion: "failure",
		title: `A execução passou de ${RUN_DEADLINE_MS / 60_000} minutos`,
		summary: n ? `${done}\n\n${toCheckResult(report, unresolved).summary}` : done,
	};
}

function failedFiles(result: ShardResult): string[] {
	return result.report.files.filter((f) => f.state === "fail").map((f) => f.path);
}

/** Keeps the shard's passing files and queues each failed one to run again alone. */
async function rerunAlone(shard: TestShard, result: ShardResult, files: string[], deps: ShardDeps): Promise<void> {
	if ((await deps.jobs.split(shard.runId, shard.shard, files.length + 1)) === "finished") return;
	await deps.enqueue(files.map((file, i) => ({ ...shard, shard: `${shard.shard}.r${i}`, files: [file], recheck: true })));
	const rest = new Set(files);
	const kept = { ...result, report: { ...result.report, files: result.report.files.filter((f) => !rest.has(f.path)) } };
	await finish(shard, `${shard.shard}.k`, kept, deps);
}

async function split(shard: TestShard, deps: ShardDeps): Promise<void> {
	const half = Math.ceil(shard.files.length / 2);
	// Enqueued even when this split was recorded before: the halves' results count once anyway.
	if ((await deps.jobs.split(shard.runId, shard.shard, 2)) === "finished") return;
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

/** What a shard attempt used, filled in by runShard for the metrics (src/metrics.ts). */
interface ShardMeter {
	/** Tail Workers that record the Dynamic Worker's CPU time. */
	tails?: Fetcher[];
	codeBytes?: number;
	/** Whether a Dynamic Worker was created. */
	loaded?: boolean;
}

/** Builds a shard's files and everything they import, and runs them in a fresh Dynamic Worker. */
async function runShard(
	github: GitHubClient,
	loader: WorkerLoader,
	shard: TestShard,
	onProgress: (event: ProgressEvent) => void,
	meter: ShardMeter = {},
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
	meter.codeBytes = size;
	if (size > MAX_CODE_BYTES) throw new TooLarge(size);
	onProgress({ type: "status", text: `${label}: rodando` });
	meter.loaded = true;
	try {
		return { report: await runInDynamicWorker(loader, bundle, onProgress, config, SHARD_DEADLINE_MS, meter.tails), unresolved };
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
	deadlineMs = SHARD_DEADLINE_MS,
	tails?: Fetcher[],
): Promise<TestReport> {
	const worker = loader.load({
		...(tails && { tails }),
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		mainModule: MAIN_MODULE,
		modules: bundle.modules,
		globalOutbound: null,
		limits: { cpuMs: 120_000 },
	});
	const { globals, testTimeout, clearMocks, mockReset, restoreMocks } = config;
	const run: RunRequest = { files: bundle.testFiles, setupFiles: bundle.setupFiles, globals, testTimeout, clearMocks, mockReset, restoreMocks };
	const signal = AbortSignal.timeout(deadlineMs);
	try {
		const res = await worker.getEntrypoint().fetch("http://tests/", { method: "POST", body: JSON.stringify(run), signal });
		if (!res.ok) throw new Error(`O Dynamic Worker respondeu ${res.status}: ${await res.text()}`);
		return await readRun(res, onProgress);
	} catch (error) {
		if (signal.aborted) throw new Error(`Os testes passaram de ${deadlineMs / 60_000} minutos rodando e foram interrompidos.`);
		throw error;
	}
}
