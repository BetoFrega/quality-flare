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
 * it. Alarms are short, so no single invocation outlives the run. Each look also shows the run so far
 * on its check runs (tests passed, failures, the end of each command's log) and in the admin, and
 * completes a command's check run as soon as the command finishes.
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
 * A run still going this long after it started is failed and its container destroyed: about twice the
 * longest real run (a full run of macae, ~11 min), since a hung run is billed for every minute it stays up.
 * qf-run.sh's step limits (STEP_MINUTES) stop a single step that hangs first.
 */
export const BOX_DEADLINE_MS = 20 * 60_000;

/** qf-run.sh's limit on the tests and on each command. */
const STEP_MINUTES = 15;

/** Without a request or an alarm for this long, Cloudflare stops the container on its own. */
const INACTIVITY_MS = 5 * 60_000;

const OUT = "/work/out";
/** GitHub caps a check run summary at 65535 characters. */
const MAX_LOG = 50_000;
/** How much of a running command's log its check run shows. */
const TAIL_BYTES = 6000;

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
			tail: (path) => readFile(container, path, TAIL_BYTES).catch(() => undefined),
			jobs: d1JobStore(this.env.RUNS),
			finished: new Set((await this.ctx.storage.get<Shown>("shown"))?.finished),
			status: (text) => live.send({ type: "status", runId: job.runId, text }),
			// Showing progress is a nicety: a GitHub error here never holds the run up.
			progress: (progress) => this.show(job, progress, live).catch(logError),
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
		const finished = await this.finished();
		for (const [i, command] of job.commands.entries()) {
			if (!finished.has(i)) await github.completeCheckRun(job.repo, command.checkRunId, results.commands[i] ?? NOT_RUN).catch(logError);
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
		const finished = await this.finished();
		const open = job.commands.filter((_, i) => !finished.has(i));
		if (!open.length) return;
		const github = await this.github(job);
		for (const command of open) await github.completeCheckRun(job.repo, command.checkRunId, COMMAND_CANCELLED).catch(logError);
	}

	/**
	 * Shows the run so far: on its check runs, each only when what it shows changed, and in the admin (the failures
	 * it hasn't sent yet, and the totals). A command that finished gets its check run completed now.
	 */
	private async show(job: BoxJob, progress: BoxProgress, live: ReturnType<typeof livePublisher>): Promise<void> {
		const shown: Shown = (await this.ctx.storage.get<Shown>("shown")) ?? { outputs: {}, finished: [], failures: 0 };
		const show = async (checkRunId: number, output: BoxProgress["commands"][number]) => {
			const text = output && hash(JSON.stringify(output));
			if (!output || shown.outputs[checkRunId] === text) return false;
			const github = await this.github(job);
			const done = "conclusion" in output;
			await (done ? github.completeCheckRun(job.repo, checkRunId, output) : github.updateCheckRun(job.repo, checkRunId, output));
			shown.outputs[checkRunId] = text;
			return done;
		};
		await show(job.checkRunId, progress.tests);
		for (const [i, command] of job.commands.entries()) if (await show(command.checkRunId, progress.commands[i])) shown.finished.push(i);
		const counts = progress.counts;
		if (counts) {
			for (const failure of counts.failures.slice(shown.failures)) {
				live.send({ type: "test", runId: job.runId, file: failure.file, name: failure.name || "(fora dos testes)", state: "fail", errors: [failure.error] });
			}
			shown.failures = Math.max(shown.failures, counts.failures.length);
			live.send({ type: "counts", runId: job.runId, pass: counts.passed, fail: counts.failed + counts.broken, other: counts.skipped, total: counts.tests || undefined });
		}
		await this.ctx.storage.put("shown", shown);
	}

	private async finished(): Promise<Set<number>> {
		return new Set((await this.ctx.storage.get<Shown>("shown"))?.finished);
	}

	/** One installation token per run, kept while the object is in memory: it lasts an hour, well past BOX_DEADLINE_MS. */
	private token?: Promise<GitHubClient>;

	private github(job: BoxJob): Promise<GitHubClient> {
		this.token ??= GitHubClient.forInstallation({ appId: this.env.GITHUB_APP_ID, privateKey: this.env.GITHUB_PRIVATE_KEY }, job.installationId).catch(
			(error: unknown) => {
				// A failed exchange is asked again on the next alarm, not kept.
				this.token = undefined;
				throw error;
			},
		);
		return this.token;
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
		...(job.full ? { FULL: "1" } : job.changed ? { CHANGED: "1", ...(config.alwaysRun?.length ? { ALWAYS_RUN: config.alwaysRun.join("\n") } : {}) } : {}),
		// A full run checks what the cache would vouch for: it builds everything, and still fills the cache.
		...(turbo ? { TURBO_API: turbo.api, TURBO_TEAM: "quality-flare", TURBO_TOKEN: turbo.token, ...(job.full ? { TURBO_FORCE: "true" } : {}) } : {}),
		...(config.install ? { INSTALL: config.install } : {}),
		...(config.vitestArgs?.length ? { VITEST_ARGS: config.vitestArgs.join("\n") } : {}),
		...(commands.length ? { COMMANDS: String(commands.length) } : {}),
		...Object.fromEntries(commands.map((c, i) => [`COMMAND_${i + 1}`, c.run])),
	};
}

/** A file of the output folder, or only its last `bytes`, from the first line that starts in them. */
async function readFile(container: Container, path: string, bytes?: number): Promise<string | undefined> {
	const command = bytes ? ["tail", "-c", String(bytes), `${OUT}/${path}`] : ["cat", `${OUT}/${path}`];
	const out = await (await container.exec(command, { stderr: "ignore" })).output();
	if (out.exitCode !== 0) return undefined;
	const text = new TextDecoder().decode(out.stdout);
	return bytes && out.stdout.byteLength >= bytes ? text.slice(text.indexOf("\n") + 1) : text;
}

/** FNV-1a, enough to tell whether what a check run shows changed. */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return `${text.length}:${(h >>> 0).toString(36)}`;
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
	/** The end of such a file. */
	tail(path: string): Promise<string | undefined>;
	jobs: Pick<JobStore, "get">;
	/** Indexes of the commands whose check runs were already completed. */
	finished: ReadonlySet<number>;
	status(text: string): void;
	/** Shows the run so far on its check runs and in the admin. */
	progress(progress: BoxProgress): Promise<void>;
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
	if (current !== "tests") {
		const status = STEP_STATUS[current] ?? "Iniciando o container";
		deps.status(`Container: ${status.toLowerCase()}`);
		const waiting = { title: "Esperando a instalação", summary: `${status}; depois este comando roda no mesmo container, junto com os testes.` };
		await deps.progress({ tests: { title: status, summary: `${status}.` }, commands: job.commands.map(() => waiting) });
		return "poll";
	}
	const steps = parseSteps((await deps.read("steps")) ?? "");
	const step = (name: string) => steps.find((s) => s.name === name);
	const running = job.commands.findIndex((_, i) => !step(`command${i + 1}`));
	const runningNames = [...(step("tests") ? [] : ["os testes"]), ...(running >= 0 ? [job.commands[running].name] : [])];
	deps.status(`Container: rodando ${runningNames.join(" e ") || "os testes"}`);
	const counts = parseProgress(await deps.read("progress.json"));
	const commands = await Promise.all(
		job.commands.map(async ({ name }, i): Promise<BoxProgress["commands"][number]> => {
			const finished = step(`command${i + 1}`);
			if (finished) return deps.finished.has(i) ? undefined : commandResult(name, finished, await deps.read(`command${i + 1}.log`));
			if (i > running) return { title: `Esperando ${job.commands[i - 1].name}`, summary: "Os comandos rodam um depois do outro, no mesmo container, junto com os testes." };
			return runningOutput(await deps.tail(`command${i + 1}.log`));
		}),
	);
	await deps.progress({ tests: testsOutput(counts, step("tests"), running >= 0 ? job.commands[running].name : undefined), commands, counts });
	return "poll";
}

const STEP_STATUS: Record<string, string> = {
	clone: "Baixando o código",
	install: "Instalando as dependências",
};

/** Kept between looks so each shows only what changed (see TestBox.show). */
interface Shown {
	/** A hash of what each check run shows, by id. */
	outputs: Record<number, string | undefined>;
	/** The commands whose check runs are completed. */
	finished: number[];
	/** Failures already sent to the admin. */
	failures: number;
}

/** The run so far, from one look at its container. */
export interface BoxProgress {
	/** What the Container tests check run shows while it runs. */
	tests: Pick<CheckResult, "title" | "summary">;
	/** Per command: what its check run shows, its result once it finished, or undefined when that was already reported. */
	commands: (Pick<CheckResult, "title" | "summary"> | CheckResult | undefined)[];
	counts?: TestProgress;
}

/** progress.json, which qf-progress.mjs keeps while the tests run. */
export interface TestProgress {
	files: number;
	filesDone: number;
	/** Tests found so far, in the files vitest already collected. */
	tests: number;
	passed: number;
	failed: number;
	skipped: number;
	/** Files that failed outside their tests: failed to load, or a hook threw. */
	broken: number;
	/** The first ones; `name` is empty for a broken file. */
	failures: { file: string; name: string; error: string }[];
}

export function parseProgress(text: string | undefined): TestProgress | undefined {
	if (!text) return undefined;
	try {
		const progress = JSON.parse(text) as TestProgress;
		return { ...progress, broken: progress.broken ?? 0, failures: progress.failures ?? [] };
	} catch {
		return undefined;
	}
}

/** What the Container tests check run shows while the tests (or the commands after them) run. */
export function testsOutput(counts: TestProgress | undefined, finished: Step | undefined, command: string | undefined): Pick<CheckResult, "title" | "summary"> {
	const after = command ? `\n\nRodando agora, no mesmo container: ${command}.` : "";
	if (!counts) return { title: "Rodando os testes", summary: `O vitest está carregando os testes.${after}` };
	const failed = counts.failed + counts.broken;
	const title = `${counts.passed} ${counts.passed === 1 ? "passou" : "passaram"}${failed ? `, ${failed} ${failed === 1 ? "falhou" : "falharam"}` : ""}${finished ? `; esperando ${command ?? "o fim"}` : ""}`;
	const lines = [
		finished ? "Os testes terminaram; o resultado sai quando os comandos do mesmo container terminarem." : `Arquivos: ${counts.filesDone} de ${counts.files}. Testes encontrados até agora: ${counts.tests}.`,
		`Passaram ${counts.passed}, falharam ${counts.failed}, pulados ${counts.skipped}${counts.broken ? `, arquivos com erro fora dos testes ${counts.broken}` : ""}.`,
	];
	const failures = counts.failures.map((f) => `**${f.file}${f.name ? ` › ${f.name}` : ""}**\n\n\`\`\`\n${fence(f.error)}\n\`\`\``);
	const more = failed > counts.failures.length ? [`… e mais ${failed - counts.failures.length} falha(s), no resultado final.`] : [];
	return { title, summary: [...lines, ...(failures.length ? ["### Falhas até agora", ...failures, ...more] : [])].join("\n\n") + after };
}

/** What a running command's check run shows: the end of its log so far. */
export function runningOutput(tail: string | undefined): Pick<CheckResult, "title" | "summary"> {
	const log = (tail ?? "").trim();
	return { title: "Rodando", summary: log ? `Final do log até agora:\n\n\`\`\`\n${fence(log)}\n\`\`\`` : "Rodando, ainda sem saída." };
}

/** Keeps a log from closing the code block it's shown in. */
const fence = (text: string) => text.replaceAll("```", "ʼʼʼ");

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
		const why = tests?.exitCode === TIMED_OUT ? `Os testes passaram do limite de ${STEP_MINUTES} minutos.` : "O vitest terminou sem gerar o relatório.";
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
	const why = step.exitCode === TIMED_OUT ? `${name} passou do limite de ${STEP_MINUTES} minutos.` : `${name} falhou (código de saída ${step.exitCode}).`;
	return { ...logFailure(why, log), title: `${name} falhou` };
}

function logFailure(why: string, log: string | undefined): CheckResult {
	const tail = fence((log ?? "").slice(-MAX_LOG));
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
	// Workers Logs keeps an Error's stack but not its message, which says what GitHub answered.
	console.error("quality-flare: container run", error instanceof Error ? `${error.message}\n${error.stack}` : error);
	return undefined;
}
