import { GitHubClient } from "../../github.ts";
import { livePublisher } from "../../live.ts";
import { d1RunStore } from "../../runs.ts";
import type { Check, CheckResult } from "../types.ts";
import { CONFIG_FILE, readContainerConfig, type ContainerConfig } from "./config.ts";
import { cancelRuns, cannotRun, CODE_ACTIONS, finishRun } from "./index.ts";
import { d1JobStore, type JobStore } from "./jobs.ts";
import { toCheckResult, type TestReport, type TestResult } from "./report.ts";

/**
 * The "Container tests" check, turned on per repository in the admin next to (or instead of) the
 * Dynamic Workers "Tests" check: each run gets a fresh container (containers/tests) that clones the
 * PR head, installs its dependencies and runs the repository's own vitest with its own config, so
 * Node-only tests run too. quality-flare.json's `container` section configures it (see
 * ContainerConfig), apart from the `tests` section of the Tests check. When it names a typecheck
 * command, that runs afterwards and reports as the "Typecheck" check run.
 *
 * The container reports only through files (see containers/tests/qf-run.sh). TestBox, one Durable
 * Object per run, starts it and reads those files on an alarm every POLL_MS until the run is done,
 * cancelled (a newer push or the cron sweep closed its job) or past BOX_DEADLINE_MS, then destroys
 * it. Alarms are short, so no single invocation outlives the run.
 */

const NAME = "Container tests";
export const TYPECHECK = "Typecheck";

/** Instance type of every run: 4 vCPU, 12 GiB, 20 GB. A smaller one uses the same CPU for longer. */
export const INSTANCE = { name: "standard-4", vcpu: 4, memoryGiB: 12, diskGB: 20 } as const;

/** Containers prices (https://developers.cloudflare.com/containers/pricing/), in US dollars. */
export const CONTAINER_PRICES = {
	/** Per GiB-second of memory, for as long as the container runs, busy or not. */
	memoryGiBs: 0.0000025,
	/** Per vCPU-second actually used. */
	vcpuS: 0.00002,
	/** Per GB-second of disk, for as long as the container runs. */
	diskGBs: 0.00000007,
} as const;

/** How often TestBox reads the container's progress. */
export const POLL_MS = 10_000;

/**
 * A run still going this long after it started is failed and its container destroyed. Above the
 * sum of qf-run.sh's step limits, which stop a step that hangs first.
 */
export const BOX_DEADLINE_MS = 55 * 60_000;

/** Without a request or an alarm for this long, Cloudflare stops the container on its own. */
const INACTIVITY_MS = 5 * 60_000;

const OUT = "/work/out";
/** GitHub caps a check run summary at 65535 characters. */
const MAX_LOG = 50_000;

/** What TestBox keeps about its run. */
export interface BoxJob {
	runId: number;
	repo: string;
	sha: string;
	installationId: number;
	checkRunId: number;
	typecheckCheckRunId?: number;
	/** Epoch milliseconds. */
	startedAt: number;
}

/** A finished step of qf-run.sh. */
export interface Step {
	name: string;
	exitCode: number;
	ms: number;
}

/** What the container left in its output folder. */
export interface BoxOutput {
	steps: Step[];
	/** vitest's JSON report, if the tests got to write it. */
	report?: string;
	logs: Partial<Record<"clone" | "install" | "tests" | "typecheck", string>>;
	/** CPU the container used, in microseconds. */
	cpuUs?: number;
}

export const containerTests: Check = {
	id: "container-tests",
	name: NAME,
	pullRequestActions: CODE_ACTIONS,
	async run({ github, repo, pr, env, installationId }) {
		const sha = pr.head.sha;
		const runs = d1RunStore(env.RUNS);
		const runId = await runs.start({ repo, pr: pr.number, sha, container: true }).catch(logError);
		const live = livePublisher(runId === undefined ? undefined : env.LIVE);
		live.send({ type: "started", runId: runId!, repo, pr: pr.number, sha });
		let checkRunId: number | undefined;
		let typecheckCheckRunId: number | undefined;
		try {
			if (runId === undefined) throw new Error("O D1 (quality-flare-runs) não respondeu; ele acompanha o container.");
			// A newer push supersedes the PR's container run still going: its TestBox sees the job gone and destroys the container.
			await cancelRuns(github, repo, await runs.running(repo, pr.number, runId), d1JobStore(env.RUNS), runs, live);
			const config = readContainerConfig(await github.getFileText(repo, sha, CONFIG_FILE));
			const detailsUrl = `${env.PUBLIC_URL}/admin/runs/${runId}`;
			checkRunId = await github.startCheckRun(repo, sha, NAME, "Rodando os testes num container", detailsUrl);
			if (config.typecheck) typecheckCheckRunId = await github.startCheckRun(repo, sha, TYPECHECK, "Rodando o typecheck num container", detailsUrl);
			await d1JobStore(env.RUNS).create(runId, { shards: 1, checkRunId, installationId });
			await startBox(env, { runId, repo, sha, installationId, checkRunId, typecheckCheckRunId, startedAt: Date.now() }, config);
			live.send({ type: "status", runId, text: "Container: iniciando" });
			await live.flush();
			return null;
		} catch (error) {
			const result = cannotRun(error);
			if (runId !== undefined) await finishRun(runs, live, runId, result);
			if (typecheckCheckRunId !== undefined) await github.completeCheckRun(repo, typecheckCheckRunId, result).catch(logError);
			if (checkRunId === undefined) return result;
			await github.completeCheckRun(repo, checkRunId, result);
			return null;
		}
	},
};

/** Starts a run's container, once the run's check runs and job exist. the run's check runs and job exist. */
export async function startBox(env: Env, job: BoxJob, config: ContainerConfig): Promise<void> {
	const stub = env.TEST_BOX.get(env.TEST_BOX.idFromName(String(job.runId)));
	const res = await stub.fetch("https://box/start", { method: "POST", body: JSON.stringify({ job, config }) });
	if (!res.ok) throw new Error(`O container não iniciou: ${await res.text()}`);
}

export class TestBox {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("Not found", { status: 404 });
		const { job, config } = (await request.json()) as { job: BoxJob; config: ContainerConfig };
		const container = this.ctx.container;
		if (!container) return new Response("Este Durable Object não tem container.", { status: 500 });
		const credentials = { appId: this.env.GITHUB_APP_ID, privateKey: this.env.GITHUB_PRIVATE_KEY };
		const token = await GitHubClient.contentsReadToken(credentials, job.installationId, job.repo);
		container.start({
			image: container.images.tests,
			instance: INSTANCE.name,
			// npm and GitHub; the token reads this repository only.
			enableInternet: true,
			env: boxEnv(job, config, token),
		});
		await container.setInactivityTimeout(INACTIVITY_MS);
		await this.ctx.storage.put("job", job);
		await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		return new Response(null, { status: 204 });
	}

	async alarm(): Promise<void> {
		const job = await this.ctx.storage.get<BoxJob>("job");
		const container = this.ctx.container;
		if (!job || !container) return;
		const live = livePublisher(this.env.LIVE);
		const next = await pollBox(job, {
			now: Date.now,
			running: () => container.running,
			// Reading fails while the container is still starting; the deadline covers one that never answers.
			read: (path) => readFile(container, path).catch(() => undefined),
			jobs: d1JobStore(this.env.RUNS),
			status: (text) => live.send({ type: "status", runId: job.runId, text }),
			publish: (results, report, usage) => this.publish(job, results, report, usage),
			abandon: (usage) => this.abandon(job, usage),
		}).catch((error: unknown) => {
			// D1 or GitHub failed: look again. A run that was already reported finds its job gone then.
			logError(error);
			return "poll" as const;
		});
		await live.flush();
		if (next === "poll") {
			await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
			return;
		}
		await container.destroy().catch(() => {});
		await this.ctx.storage.deleteAll();
	}

	/** Reports the run's check runs and history. Only the first of a run's reports counts. */
	private async publish(job: BoxJob, results: BoxResults, report: TestReport | undefined, usage: BoxUsage): Promise<void> {
		// Closing the job claims the run: a newer push or the sweep closing it first means it was already reported.
		const closed = await d1JobStore(this.env.RUNS).close(job.runId);
		await recordUsage(this.env.RUNS, job.runId, usage);
		if (!closed) return this.abandon(job, usage);
		const github = await this.github(job);
		await github.completeCheckRun(job.repo, job.checkRunId, results.tests);
		if (job.typecheckCheckRunId !== undefined && results.typecheck) {
			await github.completeCheckRun(job.repo, job.typecheckCheckRunId, results.typecheck).catch(logError);
		}
		await d1RunStore(this.env.RUNS).finish(job.runId, results.tests, report).catch(logError);
		const live = livePublisher(this.env.LIVE);
		live.send({ type: "finished", runId: job.runId, conclusion: results.tests.conclusion, title: results.tests.title });
		await live.flush();
	}

	/** The run was cancelled or swept, which reported the Tests check run; the Typecheck one is still open. */
	private async abandon(job: BoxJob, usage: BoxUsage): Promise<void> {
		await recordUsage(this.env.RUNS, job.runId, usage);
		if (job.typecheckCheckRunId === undefined) return;
		const github = await this.github(job);
		await github.completeCheckRun(job.repo, job.typecheckCheckRunId, TYPECHECK_CANCELLED).catch(logError);
	}

	private github(job: BoxJob): Promise<GitHubClient> {
		return GitHubClient.forInstallation({ appId: this.env.GITHUB_APP_ID, privateKey: this.env.GITHUB_PRIVATE_KEY }, job.installationId);
	}
}

/** The container's environment (see qf-run.sh). */
export function boxEnv(job: Pick<BoxJob, "repo" | "sha">, config: ContainerConfig, token: string): Record<string, string> {
	return {
		REPO: job.repo,
		SHA: job.sha,
		TOKEN: token,
		...(config.install ? { INSTALL: config.install } : {}),
		...(config.vitestArgs?.length ? { VITEST_ARGS: config.vitestArgs.join("\n") } : {}),
		...(config.typecheck ? { TYPECHECK: config.typecheck } : {}),
	};
}

async function readFile(container: Container, path: string): Promise<string | undefined> {
	const out = await (await container.exec(["cat", `${OUT}/${path}`], { stderr: "ignore" })).output();
	return out.exitCode === 0 ? new TextDecoder().decode(out.stdout) : undefined;
}

export interface BoxUsage {
	wallMs: number;
	cpuUs?: number;
}

export interface BoxResults {
	tests: CheckResult;
	typecheck?: CheckResult;
}

export interface PollDeps {
	now(): number;
	/** Whether the container is still up. */
	running(): boolean;
	/** A file of the container's output folder, or undefined when it doesn't exist. */
	read(path: string): Promise<string | undefined>;
	jobs: Pick<JobStore, "get">;
	status(text: string): void;
	publish(results: BoxResults, report: TestReport | undefined, usage: BoxUsage): Promise<void>;
	abandon(usage: BoxUsage): Promise<void>;
}

/** One look at a run's container: "poll" to look again later, "done" to destroy it. */
export async function pollBox(job: BoxJob, deps: PollDeps): Promise<"poll" | "done"> {
	const wallMs = deps.now() - job.startedAt;
	// A newer push cancelled the run, or the cron sweep failed it: both reported the Tests check run.
	if (!(await deps.jobs.get(job.runId))) {
		await deps.abandon({ wallMs, cpuUs: await readCpu(deps) });
		return "done";
	}
	if (await deps.read("done")) {
		const output = await readOutput(deps);
		await deps.publish(boxResults(output), output.report ? parseVitestReport(output.report) : undefined, { wallMs, cpuUs: output.cpuUs });
		return "done";
	}
	if (wallMs > BOX_DEADLINE_MS || !deps.running()) {
		const output = await readOutput(deps);
		const why = deps.running()
			? `A execução passou de ${BOX_DEADLINE_MS / 60_000} minutos e o container foi destruído.`
			: "O container parou antes de terminar (falta de memória ou de disco, provavelmente).";
		await deps.publish(stopped(why, output), undefined, { wallMs, cpuUs: output.cpuUs });
		return "done";
	}
	const current = (await deps.read("current"))?.trim();
	deps.status(STEP_STATUS[current ?? ""] ?? "Iniciando o container");
	return "poll";
}

const STEP_STATUS: Record<string, string> = {
	clone: "Container: baixando o código",
	install: "Container: instalando as dependências",
	tests: "Container: rodando os testes",
	typecheck: "Container: rodando o typecheck",
};

async function readCpu(deps: Pick<PollDeps, "read">): Promise<number | undefined> {
	const cpu = Number((await deps.read("cpu").catch(() => undefined))?.trim());
	return Number.isFinite(cpu) && cpu > 0 ? cpu : undefined;
}

async function readOutput(deps: Pick<PollDeps, "read">): Promise<BoxOutput> {
	const read = (path: string) => deps.read(path).catch(() => undefined);
	const [steps, report, clone, install, tests, typecheck, cpuUs] = await Promise.all([
		read("steps"),
		read("report.json"),
		read("clone.log"),
		read("install.log"),
		read("tests.log"),
		read("typecheck.log"),
		readCpu(deps),
	]);
	return { steps: parseSteps(steps ?? ""), report, logs: { clone, install, tests, typecheck }, cpuUs };
}

export function parseSteps(text: string): Step[] {
	return text
		.split("\n")
		.map((line) => line.trim().split(" "))
		.filter((parts) => parts.length === 3)
		.map(([name, exitCode, ms]) => ({ name, exitCode: Number(exitCode), ms: Number(ms) }));
}

/** timeout(1) exits with 124 when it stopped the command. */
const TIMED_OUT = 124;

/** The check run results of a run whose container finished. */
export function boxResults(output: BoxOutput): BoxResults {
	const step = (name: string) => output.steps.find((s) => s.name === name);
	const typecheck = typecheckResult(step("typecheck"), output.logs.typecheck);
	for (const name of ["clone", "install"] as const) {
		const s = step(name);
		if (!s || s.exitCode !== 0) return stopped(failedStep(name, s), output);
	}
	const tests = step("tests");
	const report = output.report ? parseVitestReport(output.report) : undefined;
	if (!report || tests?.exitCode === TIMED_OUT) {
		const why = tests?.exitCode === TIMED_OUT ? "Os testes passaram do limite de 25 minutos." : "O vitest terminou sem gerar o relatório.";
		return { tests: logFailure(why, output.logs.tests), typecheck };
	}
	if (!report.files.length) return { tests: NO_TESTS, typecheck };
	return { tests: toCheckResult(report), typecheck };
}

/** Results when the run stopped before the tests: Tests fails with why, Typecheck (if any) didn't run. */
function stopped(why: string, output: BoxOutput): BoxResults {
	const log = [output.logs.clone, output.logs.install, output.logs.tests].filter(Boolean).join("\n");
	return { tests: logFailure(why, log), typecheck: { conclusion: "neutral", title: "Não rodou", summary: why } };
}

function failedStep(name: "clone" | "install", step: Step | undefined): string {
	const what = name === "clone" ? "Não foi possível baixar o código" : "A instalação das dependências falhou";
	if (!step) return `${what}.`;
	return step.exitCode === TIMED_OUT ? `${what}: passou do tempo limite.` : `${what} (código de saída ${step.exitCode}).`;
}

function typecheckResult(step: Step | undefined, log: string | undefined): CheckResult | undefined {
	if (!step) return undefined;
	if (step.exitCode === 0) return { conclusion: "success", title: "Typecheck passou", summary: `Sem erros, em ${(step.ms / 1000).toFixed(0)} s.` };
	const why = step.exitCode === TIMED_OUT ? "O typecheck passou do limite de 10 minutos." : `O typecheck falhou (código de saída ${step.exitCode}).`;
	return { ...logFailure(why, log), title: "Typecheck falhou" };
}

function logFailure(why: string, log: string | undefined): CheckResult {
	const tail = (log ?? "").slice(-MAX_LOG).replaceAll("```", "ʼʼʼ");
	return {
		conclusion: "failure",
		title: why.replace(/[.:].*$/, ""),
		summary: tail.trim() ? `${why}\n\n\`\`\`\n${tail}\n\`\`\`` : why,
	};
}

interface VitestJson {
	testResults?: {
		name: string;
		status: string;
		message?: string;
		assertionResults?: { ancestorTitles?: string[]; title: string; status: string; failureMessages?: string[] }[];
	}[];
}

const STATE: Record<string, string> = { passed: "pass", failed: "fail", skipped: "skip", pending: "skip", todo: "todo", disabled: "skip" };

/** vitest's JSON report as the TestReport the Dynamic Workers runner makes, with paths relative to the clone. */
export function parseVitestReport(json: string, root = "/work/repo/"): TestReport | undefined {
	let data: VitestJson;
	try {
		data = JSON.parse(json) as VitestJson;
	} catch {
		return undefined;
	}
	const files = (data.testResults ?? []).map((file) => {
		const tests: TestResult[] = (file.assertionResults ?? []).map((t) => ({
			name: [...(t.ancestorTitles ?? []), t.title].join(" › "),
			state: STATE[t.status] ?? t.status,
			...(t.failureMessages?.length ? { errors: t.failureMessages } : {}),
		}));
		const state = file.status === "passed" ? "pass" : file.status === "failed" ? "fail" : file.status;
		// A file that failed with no failing test failed to load, or a hook outside the tests threw.
		const broken = state === "fail" && !tests.some((t) => t.state === "fail");
		return {
			path: file.name.startsWith(root) ? file.name.slice(root.length) : file.name,
			state,
			...(broken ? { errors: [file.message || "O arquivo falhou fora dos testes."] } : {}),
			tests,
		};
	});
	return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Estimated price of a run's container. Memory and disk count for as long as it ran, CPU only as used. */
export function boxCost({ wallMs, cpuUs }: BoxUsage): number {
	const seconds = wallMs / 1000;
	return (
		INSTANCE.memoryGiB * seconds * CONTAINER_PRICES.memoryGiBs +
		INSTANCE.diskGB * seconds * CONTAINER_PRICES.diskGBs +
		((cpuUs ?? 0) / 1_000_000) * CONTAINER_PRICES.vcpuS
	);
}

/** Usage goes in the run's test_container_runs row, created with the run (src/runs.ts). */
async function recordUsage(db: D1Database, runId: number, usage: BoxUsage): Promise<void> {
	await db
		.prepare("UPDATE test_container_runs SET instance = ?, wall_ms = ?, cpu_us = ? WHERE run_id = ?")
		.bind(INSTANCE.name, usage.wallMs, usage.cpuUs ?? null, runId)
		.run()
		.catch(logError);
}

/** A run's container usage, for the admin; undefined for runs that didn't use a container or are still going. */
export async function containerUsage(db: D1Database, runId: number): Promise<BoxUsage | undefined> {
	const row = await db
		.prepare("SELECT wall_ms, cpu_us FROM test_container_runs WHERE run_id = ? AND wall_ms IS NOT NULL")
		.bind(runId)
		.first<{ wall_ms: number; cpu_us: number | null }>();
	return row ? { wallMs: row.wall_ms, cpuUs: row.cpu_us ?? undefined } : undefined;
}

const TYPECHECK_CANCELLED: CheckResult = {
	conclusion: "cancelled",
	title: "Cancelado",
	summary: "A execução foi cancelada (um push mais novo) ou passou do prazo antes do typecheck terminar.",
};

const NO_TESTS: CheckResult = {
	conclusion: "neutral",
	title: "Nenhum teste encontrado",
	summary: "O vitest do repositório não encontrou arquivos de teste.",
};

function logError(error: unknown): undefined {
	console.error("quality-flare: container run", error);
	return undefined;
}
