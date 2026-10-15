import { exports } from "cloudflare:workers";
import { GitHubClient } from "../../github.ts";
import { livePublisher } from "../../live.ts";
import { d1RunStore } from "../../runs.ts";
import { TURBO_PATH, turboToken } from "../../turbo-cache.ts";
import type { Check, CheckResult } from "../types.ts";
import { CONFIG_FILE, containerCommands, readContainerConfig, type ContainerCommand, type ContainerConfig } from "./config.ts";
import { cancelRuns, cannotRun, CODE_ACTIONS, finishRun } from "./index.ts";
import { d1JobStore, type JobStore } from "./jobs.ts";
import { toCheckResult, type TestReport, type TestResult } from "./report.ts";

/**
 * The "Container tests" check, turned on per repository in the admin next to (or instead of) the
 * Dynamic Workers "Tests" check: each run gets a fresh container (containers/tests) that clones the
 * PR head merged into its base, installs its dependencies and runs the repository's own vitest with its own config, so
 * Node-only tests run too. quality-flare.json's `container` section configures it (see
 * ContainerConfig), apart from the `tests` section of the Tests check. Its commands (typecheck,
 * lint…) run afterwards in the same container, each reported as its own check run.
 *
 * The container reports only through files (see containers/tests/qf-run.sh). TestBox, one Durable
 * Object per run, starts it and reads those files on an alarm every POLL_MS until the run is done,
 * cancelled (a newer push or the cron sweep closed its job) or past BOX_DEADLINE_MS, then destroys
 * it. Alarms are short, so no single invocation outlives the run.
 */

const NAME = "Container tests";

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
 * A run still going this long after it started is failed and its container destroyed, below the
 * cron sweep's hour. qf-run.sh's step limits stop a single step that hangs first.
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
	/** The PR's base branch, fetched with the head for commands that compare against it. */
	base: string;
	installationId: number;
	checkRunId: number;
	/** The config's commands, in the order they run, with their check runs. */
	commands: BoxCommand[];
	/** Epoch milliseconds. */
	startedAt: number;
	/** Only the tests that depend on what the PR changed (the config's `changed`). */
	changed?: true;
	/** The daily run on the default branch: every test, with nothing to compare against (see qf-run.sh). */
	full?: true;
}

export interface BoxCommand {
	name: string;
	checkRunId: number;
}

/** A finished step of qf-run.sh: clone, install, tests, then command1, command2… */
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
	/** Each step's log, by step name. */
	logs: Record<string, string | undefined>;
	/** CPU the container used, in microseconds. */
	cpuUs?: number;
}

export const containerTests: Check = {
	id: "container-tests",
	name: NAME,
	pullRequestActions: CODE_ACTIONS,
	onDemand: true,
	run({ github, repo, pr, env, installationId }) {
		const base = pr.base.ref;
		// A PR branched before the repository added its config runs with the base branch's, not vitest's defaults.
		const config = async () => readContainerConfig((await github.getFileText(repo, pr.head.sha, CONFIG_FILE)) ?? (await github.getFileText(repo, base, CONFIG_FILE)));
		return startRun({ github, env, installationId, repo, pr: pr.number, sha: pr.head.sha, base, config });
	},
};

/** What one Container tests run tests, and where it reports. */
export interface RunTarget {
	github: GitHubClient;
	env: Env;
	installationId: number;
	repo: string;
	/** 0 for a full run, which has no PR. */
	pr: number;
	sha: string;
	base: string;
	/** The commit on its own, with every test, ignoring `changed`: the daily run on the default branch. */
	full?: boolean;
	/** Reads the run's config; an invalid one fails the run. */
	config(): Promise<ContainerConfig>;
}

/** Starts a run: its history, check runs, job and container. Resolves to a result only when it couldn't start and has no check run. */
export async function startRun({ github, env, installationId, repo, pr, sha, base, full, config: readConfig }: RunTarget): Promise<CheckResult | null> {
	const runs = d1RunStore(env.RUNS);
	const runId = await runs.start({ repo, pr, sha, container: true }).catch(logError);
	const live = livePublisher(runId === undefined ? undefined : env.LIVE);
	live.send({ type: "started", runId: runId!, repo, pr, sha });
	let checkRunId: number | undefined;
	const commands: BoxCommand[] = [];
	try {
		if (runId === undefined) throw new Error("O D1 (quality-flare-runs) não respondeu; ele acompanha o container.");
		// A newer push supersedes the PR's container run still going: its TestBox sees the job gone and destroys the container.
		await cancelRuns(github, repo, await runs.running(repo, pr, runId), d1JobStore(env.RUNS), runs, live);
		const config = await readConfig();
		const detailsUrl = `${env.PUBLIC_URL}/admin/runs/${runId}`;
		checkRunId = await github.startCheckRun(repo, sha, NAME, full ? "Rodando todos os testes num container" : "Rodando os testes num container", detailsUrl);
		for (const { name } of containerCommands(config)) {
			commands.push({ name, checkRunId: await github.startCheckRun(repo, sha, name, "Esperando os testes, no mesmo container", detailsUrl) });
		}
		await d1JobStore(env.RUNS).create(runId, { shards: 1, checkRunId, installationId });
		const scope = full ? { full: true as const } : config.changed ? { changed: true as const } : {};
		await startBox({ runId, repo, sha, base, installationId, checkRunId, commands, startedAt: Date.now(), ...scope }, config);
		live.send({ type: "status", runId, text: "Container: iniciando" });
		await live.flush();
		return null;
	} catch (error) {
		const result = cannotRun(error);
		if (runId !== undefined) await finishRun(runs, live, runId, result);
		for (const command of commands) await github.completeCheckRun(repo, command.checkRunId, result).catch(logError);
		if (checkRunId === undefined) return result;
		await github.completeCheckRun(repo, checkRunId, result);
		return null;
	}
}

/** Starts a run's container, once the run's check runs and job exist. */
export async function startBox(job: BoxJob, config: ContainerConfig, boxes: DurableObjectNamespace = exports.TestBox): Promise<void> {
	const stub = boxes.get(boxes.idFromName(String(job.runId)));
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
		const turbo = config.turboCache ? { api: `${this.env.PUBLIC_URL}${TURBO_PATH}`, token: await turboToken(this.env.GITHUB_WEBHOOK_SECRET, job.repo) } : undefined;
		container.start({
			image: container.images.tests,
			instance: INSTANCE.name,
			// npm, GitHub and the Turborepo cache; the tokens reach this repository only.
			enableInternet: true,
			env: boxEnv(job, config, token, turbo),
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
		for (const [i, command] of job.commands.entries()) {
			await github.completeCheckRun(job.repo, command.checkRunId, results.commands[i] ?? NOT_RUN).catch(logError);
		}
		await d1RunStore(this.env.RUNS).finish(job.runId, results.tests, report).catch(logError);
		if (job.full) await alertFullRun(github, job, results, `${this.env.PUBLIC_URL}/admin/runs/${job.runId}`).catch(logError);
		const live = livePublisher(this.env.LIVE);
		live.send({ type: "finished", runId: job.runId, conclusion: results.tests.conclusion, title: results.tests.title });
		await live.flush();
	}

	/** The run was cancelled or swept, which reported the Container tests check run; the commands' are still open. */
	private async abandon(job: BoxJob, usage: BoxUsage): Promise<void> {
		await recordUsage(this.env.RUNS, job.runId, usage);
		if (!job.commands.length) return;
		const github = await this.github(job);
		for (const command of job.commands) await github.completeCheckRun(job.repo, command.checkRunId, COMMAND_CANCELLED).catch(logError);
	}

	private github(job: BoxJob): Promise<GitHubClient> {
		return GitHubClient.forInstallation({ appId: this.env.GITHUB_APP_ID, privateKey: this.env.GITHUB_PRIVATE_KEY }, job.installationId);
	}
}

/**
 * A failed full run means something broke that the PRs' runs, limited to what each changed, missed: an issue says so,
 * since nobody watches the default branch's check runs.
 */
export async function alertFullRun(github: Pick<GitHubClient, "createIssue">, job: BoxJob, results: BoxResults, runUrl: string): Promise<string | undefined> {
	const failed = [{ name: NAME, result: results.tests }, ...job.commands.map((c, i) => ({ name: c.name, result: results.commands[i] }))].filter(
		(c) => c.result?.conclusion === "failure",
	);
	if (!failed.length) return undefined;
	const body = [
		`A run completa diária do quality-flare em \`${job.base}\` (${job.sha}) falhou:`,
		"",
		...failed.map((c) => `- **${c.name}**: ${c.result!.title}`),
		"",
		"As PRs rodam só os testes afetados pelo que mudam, então alguma mudança já na branch quebrou algo que a run dela não cobriu.",
		"",
		`Detalhes: ${runUrl}`,
	].join("\n");
	return github.createIssue(job.repo, `A run completa de ${job.base} falhou em ${job.sha.slice(0, 7)}`, body);
}

/** The container's environment (see qf-run.sh). */
export function boxEnv(
	job: Pick<BoxJob, "repo" | "sha" | "base" | "changed" | "full">,
	config: ContainerConfig,
	token: string,
	turbo?: { api: string; token: string },
): Record<string, string> {
	const commands = containerCommands(config);
	return {
		REPO: job.repo,
		SHA: job.sha,
		BASE: job.base,
		TOKEN: token,
		...(job.full ? { FULL: "1" } : job.changed ? { CHANGED: "1" } : {}),
		// A full run checks what the cache would vouch for: it builds everything, and still fills the cache.
		...(turbo ? { TURBO_API: turbo.api, TURBO_TEAM: "quality-flare", TURBO_TOKEN: turbo.token, ...(job.full ? { TURBO_FORCE: "true" } : {}) } : {}),
		...(config.install ? { INSTALL: config.install } : {}),
		...(config.vitestArgs?.length ? { VITEST_ARGS: config.vitestArgs.join("\n") } : {}),
		...(commands.length ? { COMMANDS: String(commands.length) } : {}),
		...Object.fromEntries(commands.map((c, i) => [`COMMAND_${i + 1}`, c.run])),
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
	/** One per command of the job, in order; missing for a command that didn't run. */
	commands: (CheckResult | undefined)[];
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
		const output = await readOutput(deps, job.commands.length);
		await deps.publish(boxResults(output, job.commands, job.changed), output.report ? parseVitestReport(output.report) : undefined, { wallMs, cpuUs: output.cpuUs });
		return "done";
	}
	if (wallMs > BOX_DEADLINE_MS || !deps.running()) {
		const output = await readOutput(deps, job.commands.length);
		const why = deps.running()
			? `A execução passou de ${BOX_DEADLINE_MS / 60_000} minutos e o container foi destruído.`
			: "O container parou antes de terminar (falta de memória ou de disco, provavelmente).";
		await deps.publish(stopped(why, output), undefined, { wallMs, cpuUs: output.cpuUs });
		return "done";
	}
	const current = (await deps.read("current"))?.trim() ?? "";
	deps.status(current === "tests" ? await runningStatus(job, deps) : (STEP_STATUS[current] ?? "Iniciando o container"));
	return "poll";
}

/** The tests run alongside the commands, which run one after another: names the tests, if still running, and the command running. */
async function runningStatus(job: BoxJob, deps: Pick<PollDeps, "read">): Promise<string> {
	const finished = new Set(parseSteps((await deps.read("steps")) ?? "").map((s) => s.name));
	const command = job.commands.find((_, i) => !finished.has(`command${i + 1}`));
	const running = [...(finished.has("tests") ? [] : ["os testes"]), ...(command ? [command.name] : [])];
	return `Container: rodando ${running.join(" e ") || "os testes"}`;
}

const STEP_STATUS: Record<string, string> = {
	clone: "Container: baixando o código",
	install: "Container: instalando as dependências",
};

async function readCpu(deps: Pick<PollDeps, "read">): Promise<number | undefined> {
	const cpu = Number((await deps.read("cpu").catch(() => undefined))?.trim());
	return Number.isFinite(cpu) && cpu > 0 ? cpu : undefined;
}

async function readOutput(deps: Pick<PollDeps, "read">, commands: number): Promise<BoxOutput> {
	const read = (path: string) => deps.read(path).catch(() => undefined);
	const names = ["clone", "install", "tests", ...Array.from({ length: commands }, (_, i) => `command${i + 1}`)];
	const [steps, report, cpuUs, ...logs] = await Promise.all([read("steps"), read("report.json"), readCpu(deps), ...names.map((n) => read(`${n}.log`))]);
	return { steps: parseSteps(steps ?? ""), report, logs: Object.fromEntries(names.map((n, i) => [n, logs[i]])), cpuUs };
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
export function boxResults(output: BoxOutput, commands: Pick<BoxCommand, "name">[] = [], changed = false): BoxResults {
	const step = (name: string) => output.steps.find((s) => s.name === name);
	for (const name of ["clone", "install"] as const) {
		const s = step(name);
		if (!s || s.exitCode !== 0) return stopped(failedStep(name, s), output);
	}
	const results = {
		commands: commands.map(({ name }, i) => commandResult(name, step(`command${i + 1}`), output.logs[`command${i + 1}`])),
	};
	const tests = step("tests");
	const report = output.report ? parseVitestReport(output.report) : undefined;
	if (!report || tests?.exitCode === TIMED_OUT) {
		const why = tests?.exitCode === TIMED_OUT ? "Os testes passaram do limite de 25 minutos." : "O vitest terminou sem gerar o relatório.";
		return { ...results, tests: logFailure(why, output.logs.tests) };
	}
	if (!report.files.length) return { ...results, tests: changed ? NOTHING_AFFECTED : NO_TESTS };
	const result = toCheckResult(report);
	if (changed && result.conclusion === "success") result.title += ", só os afetados pela PR";
	return { ...results, tests: result };
}

/** Results when the run stopped early: Container tests fails with why, and the commands that didn't finish didn't run. */
function stopped(why: string, output: BoxOutput): BoxResults {
	const log = [output.logs.clone, output.logs.install, output.logs.tests].filter(Boolean).join("\n");
	return { tests: logFailure(why, log), commands: [] };
}

function failedStep(name: "clone" | "install", step: Step | undefined): string {
	const what = name === "clone" ? "Não foi possível baixar o código" : "A instalação das dependências falhou";
	if (!step) return `${what}.`;
	return step.exitCode === TIMED_OUT ? `${what}: passou do tempo limite.` : `${what} (código de saída ${step.exitCode}).`;
}

function commandResult(name: string, step: Step | undefined, log: string | undefined): CheckResult | undefined {
	if (!step) return undefined;
	if (step.exitCode === 0) return { conclusion: "success", title: `${name} passou`, summary: `Sem erros, em ${(step.ms / 1000).toFixed(0)} s.` };
	const why = step.exitCode === TIMED_OUT ? `${name} passou do limite de 20 minutos.` : `${name} falhou (código de saída ${step.exitCode}).`;
	return { ...logFailure(why, log), title: `${name} falhou` };
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

const COMMAND_CANCELLED: CheckResult = {
	conclusion: "cancelled",
	title: "Cancelado",
	summary: "A execução foi cancelada (um push mais novo) ou passou do prazo antes deste comando terminar.",
};

const NOT_RUN: CheckResult = {
	conclusion: "neutral",
	title: "Não rodou",
	summary: "O container parou antes de chegar a este comando; o check Container tests diz por quê.",
};

const NO_TESTS: CheckResult = {
	conclusion: "neutral",
	title: "Nenhum teste encontrado",
	summary: "O vitest do repositório não encontrou arquivos de teste.",
};

const NOTHING_AFFECTED: CheckResult = {
	conclusion: "success",
	title: "Nenhum teste afetado pela PR",
	summary: "Nenhum arquivo de teste depende do que a PR mudou (`vitest --changed`). A run completa diária da branch principal roda todos.",
};

function logError(error: unknown): undefined {
	console.error("quality-flare: container run", error);
	return undefined;
}
