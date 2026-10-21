import { exports } from "cloudflare:workers";
import { GitHubClient } from "../../github.ts";
import { livePublisher } from "../../live.ts";
import { d1RunStore } from "../../runs.ts";
import { TURBO_PATH, turboToken } from "../../turbo-cache.ts";
import type { Check, CheckResult } from "../types.ts";
import { CONFIG_FILE, containerCommands, readContainerConfig, type ContainerCommand, type ContainerConfig } from "./config.ts";
import { cancelRuns, cannotRun, CODE_ACTIONS, finishRun } from "./index.ts";
import { DEFAULT_INSTANCE, instanceSize, type InstanceType } from "./instances.ts";
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
 * How long a container may take to come up from a snapshot before the run gives up on it and starts from the image,
 * and then how long that image gets.
 */
export const RESTORE_WAIT_MS = 2 * 60_000;

/**
 * A run still going this long after it started is failed and its container destroyed: about twice the
 * longest full run seen so far (~11 min, on a large monorepo), since a hung run is billed for every minute it stays up.
 * qf-run.sh's step limits (STEP_MINUTES) stop a single step that hangs first.
 */
export const BOX_DEADLINE_MS = 20 * 60_000;

/** qf-run.sh's limit on the tests and on each command. */
const STEP_MINUTES = 15;

/** Without a request or an alarm for this long, Cloudflare stops the container on its own. */
const INACTIVITY_MS = 5 * 60_000;

/** How long a run whose container went away keeps trying to close its commands' check runs. */
const CLOSE_RETRY_MS = 60 * 60_000;

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
	/** The snapshot its container started from (see TestBox.start). */
	restored?: string;
	/** When the image was started instead of a snapshot that never came up (epoch milliseconds). */
	fallbackAt?: number;
	/** The config's `instance`; jobs started before it existed ran on DEFAULT_INSTANCE. */
	instance?: InstanceType;
}

/** The last snapshot kept for a repository (the config's `snapshot`), in SETTINGS under snapshotKey. */
export interface SavedSnapshot {
	id: string;
	/** The image it was taken on; a snapshot doesn't start on another. */
	image: string;
	size: number;
	/** The commit whose run took it. */
	sha: string;
	/** Epoch milliseconds. */
	at: number;
}

export const snapshotKey = (repo: string) => `snapshot:${repo.toLowerCase()}`;

/**
 * A custom `install` turns snapshots off: the skipped install is told apart only by the dependency files, and a
 * wrapper script can change what it installs without touching them.
 */
export const usesSnapshot = (config: Pick<ContainerConfig, "snapshot" | "install">) => Boolean(config.snapshot && !config.install);

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
		if (runId === undefined) throw new Error("D1 (quality-flare-runs) did not respond. It tracks the container.");
		// A newer push supersedes the PR's container run still going: its TestBox sees the job gone and destroys the container.
		await cancelRuns(github, repo, await runs.running(repo, pr, runId), d1JobStore(env.RUNS), runs, live);
		const config = await readConfig();
		const detailsUrl = `${env.PUBLIC_URL}/admin/runs/${runId}`;
		checkRunId = await github.startCheckRun(repo, sha, NAME, full ? "Running all tests in a container" : "Running the tests in a container", detailsUrl);
		for (const { name } of containerCommands(config)) {
			commands.push({ name, checkRunId: await github.startCheckRun(repo, sha, name, "Waiting for the tests, in the same container", detailsUrl) });
		}
		await d1JobStore(env.RUNS).create(runId, { shards: 1, checkRunId, installationId });
		const scope = full ? { full: true as const } : config.changed ? { changed: true as const } : {};
		await startBox({ runId, repo, sha, base, installationId, checkRunId, commands, startedAt: Date.now(), instance: config.instance ?? DEFAULT_INSTANCE, ...scope }, config);
		live.send({ type: "status", runId, text: "Container: starting" });
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
	if (!res.ok) throw new Error(`The container did not start: ${await res.text()}`);
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
		if (!container) return new Response("This Durable Object has no container.", { status: 500 });
		const started = await this.start(container, job, config);
		await container.setInactivityTimeout(INACTIVITY_MS);
		await this.ctx.storage.put({ job: started, config });
		await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		return new Response(null, { status: 204 });
	}

	/**
	 * Starts the run's container. With the config's `snapshot`, from the repository's last snapshot when it was
	 * taken on this image: its clone and installed dependencies save the run the install (qf-run.sh).
	 */
	private async start(container: Container, job: BoxJob, config: ContainerConfig, fresh = false): Promise<BoxJob> {
		const credentials = { appId: this.env.GITHUB_APP_ID, privateKey: this.env.GITHUB_PRIVATE_KEY };
		const token = await GitHubClient.contentsReadToken(credentials, job.installationId, job.repo);
		// The config's Turborepo cache and its `cache` paths are both kept by src/turbo-cache.ts.
		const secret = this.env.GITHUB_WEBHOOK_SECRET;
		const turbo = config.turboCache || config.cache?.length
			? { api: `${this.env.PUBLIC_URL}${TURBO_PATH}`, token: await turboToken(secret, job.repo), cacheToken: await turboToken(secret, job.repo, job.full ? "files" : "read") }
			: undefined;
		// npm, GitHub and quality-flare's caches; the tokens reach this repository only.
		const options = { instance: job.instance ?? DEFAULT_INSTANCE, enableInternet: true, env: boxEnv(job, config, token, turbo) };
		const { restored: _, ...rest } = job;
		const saved = usesSnapshot(config) && !fresh ? await this.env.SETTINGS.get<SavedSnapshot>(snapshotKey(job.repo), "json") : null;
		if (saved && saved.image === container.images.tests) {
			try {
				container.start({ ...options, containerSnapshot: { id: saved.id } });
				return { ...rest, restored: saved.id };
			} catch (error) {
				logError(error);
			}
		}
		container.start({ ...options, image: container.images.tests });
		return rest;
	}

	/** Forgets the repository's snapshot, unless a newer one already replaced it. */
	private async forgetSnapshot(repo: string, id: string): Promise<void> {
		const saved = await this.env.SETTINGS.get<SavedSnapshot>(snapshotKey(repo), "json");
		if (saved?.id === id) await this.env.SETTINGS.delete(snapshotKey(repo));
	}

	/**
	 * A container that just installed the base's lockfile waits, before running anything else, with qf-run.sh's
	 * `snapshot` file: it becomes the repository's snapshot, and the run goes on once the file is gone.
	 */
	private async takeSnapshot(container: Container, job: BoxJob): Promise<void> {
		if ((await readFile(container, "snapshot").catch(() => undefined)) === undefined) return;
		try {
			// npm's download cache only makes the snapshot bigger.
			await (await container.exec(["sh", "-c", "rm -rf /root/.npm; sync"])).output();
			const snapshot = await container.snapshotContainer({ name: `${job.repo}@${job.sha.slice(0, 7)}` });
			const saved: SavedSnapshot = { id: snapshot.id, image: container.images.tests, size: snapshot.size, sha: job.sha, at: Date.now() };
			await this.env.SETTINGS.put(snapshotKey(job.repo), JSON.stringify(saved));
		} finally {
			await (await container.exec(["rm", "-f", `${OUT}/snapshot`])).output();
		}
	}

	/** A run from a snapshot whose install failed forgets the snapshot: what it left in node_modules may be the cause. */
	private async checkRestored(container: Container, job: BoxJob): Promise<void> {
		if (!job.restored) return;
		const steps = parseSteps((await readFile(container, "steps").catch(() => undefined)) ?? "");
		if (steps.some((s) => s.name === "install" && s.exitCode !== 0)) await this.forgetSnapshot(job.repo, job.restored);
	}

	async alarm(): Promise<void> {
		const job = await this.ctx.storage.get<BoxJob>("job");
		const config = (await this.ctx.storage.get<ContainerConfig>("config")) ?? {};
		const container = this.ctx.container;
		if (!job) return;
		if (!container) {
			// A deploy without the tests (no Workers Paid) took the container away mid-run: close the commands' check
			// runs, which only this object knows (the sweep closes the run itself), trying again while GitHub fails.
			let since = await this.ctx.storage.get<number>("closing");
			if (since === undefined) {
				since = Date.now();
				await this.ctx.storage.put("closing", since);
				await recordUsage(this.env.RUNS, job, { wallMs: since - job.startedAt });
			}
			if (!(await this.closeCommands(job)) && Date.now() - since < CLOSE_RETRY_MS) {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				return;
			}
			await this.ctx.storage.deleteAll();
			return;
		}
		// A cancelled run (its job gone) skips the wait: pollBox below abandons it at once.
		if ((job.restored || job.fallbackAt) && !(await this.ctx.storage.get("seen")) && (await d1JobStore(this.env.RUNS).get(job.runId))) {
			if (!container.running) {
				// A big snapshot takes a while to restore; one that never comes up (expired, say) is forgotten, and
				// the run starts over from the image, which gets the same time to come up.
				if (Date.now() - (job.fallbackAt ?? job.startedAt) < RESTORE_WAIT_MS) {
					await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
					return;
				}
				if (job.restored) {
					await this.forgetSnapshot(job.repo, job.restored);
					// A restore still starting would hold the instance the image needs.
					await container.destroy().catch(() => {});
					await this.ctx.storage.put("job", { ...(await this.start(container, job, config, true)), fallbackAt: Date.now() });
					await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
					return;
				}
			} else await this.ctx.storage.put("seen", true);
		}
		// Only the daily full run, which runs the default branch's own code, may offer its container: a PR's tests
		// and commands can write the `snapshot` file too.
		if (job.full && usesSnapshot(config) && container.running) await this.takeSnapshot(container, job).catch(logError);
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
		if (container.running) await this.checkRestored(container, job).catch(logError);
		await container.destroy().catch(() => {});
		await this.ctx.storage.deleteAll();
	}

	/** Reports the run's check runs and history. Only the first of a run's reports counts. */
	private async publish(job: BoxJob, results: BoxResults, report: TestReport | undefined, usage: BoxUsage): Promise<void> {
		// Closing the job claims the run: a newer push or the sweep closing it first means it was already reported.
		const closed = await d1JobStore(this.env.RUNS).close(job.runId);
		await recordUsage(this.env.RUNS, job, usage);
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
		await recordUsage(this.env.RUNS, job, usage);
		const finished = await this.finished();
		const open = job.commands.filter((_, i) => !finished.has(i));
		if (!open.length) return;
		const github = await this.github(job);
		for (const command of open) await github.completeCheckRun(job.repo, command.checkRunId, COMMAND_CANCELLED).catch(logError);
	}

	/** Completes the commands' check runs still open, keeping which closed; whether all are closed now. */
	private async closeCommands(job: BoxJob): Promise<boolean> {
		const shown: Shown = (await this.ctx.storage.get<Shown>("shown")) ?? { outputs: {}, finished: [], failures: 0 };
		try {
			const github = await this.github(job);
			for (const [i, command] of job.commands.entries()) {
				if (shown.finished.includes(i)) continue;
				await github.completeCheckRun(job.repo, command.checkRunId, COMMAND_CANCELLED);
				shown.finished.push(i);
			}
			return true;
		} catch (error) {
			logError(error);
			return false;
		} finally {
			await this.ctx.storage.put("shown", shown);
		}
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
				live.send({ type: "test", runId: job.runId, file: failure.file, name: failure.name || "(outside the tests)", state: "fail", errors: [failure.error] });
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
		`The daily full quality-flare run on \`${job.base}\` (${job.sha}) failed:`,
		"",
		...failed.map((c) => `- **${c.name}**: ${c.result!.title}`),
		"",
		"PRs run only the tests affected by what they change, so a change already on the branch broke something its PR run did not cover.",
		"",
		`Details: ${runUrl}`,
	].join("\n");
	return github.createIssue(job.repo, `The full run of ${job.base} failed at ${job.sha.slice(0, 7)}`, body);
}

/** The container's environment (see qf-run.sh). */
export function boxEnv(
	job: Pick<BoxJob, "repo" | "sha" | "base" | "changed" | "full" | "startedAt">,
	config: ContainerConfig,
	token: string,
	turbo?: { api: string; token: string; cacheToken: string },
): Record<string, string> {
	const commands = containerCommands(config);
	return {
		REPO: job.repo,
		SHA: job.sha,
		BASE: job.base,
		TOKEN: token,
		...(job.full ? { FULL: "1" } : job.changed ? { CHANGED: "1", ...(config.alwaysRun?.length ? { ALWAYS_RUN: config.alwaysRun.join("\n") } : {}) } : {}),
		// A full run checks what the cache would vouch for: it builds everything, and still fills the cache.
		...(turbo && config.turboCache ? { TURBO_API: turbo.api, TURBO_TEAM: "quality-flare", TURBO_TOKEN: turbo.token, ...(job.full ? { TURBO_FORCE: "true" } : {}) } : {}),
		// Like snapshots, off with a custom `install`: what it installs isn't in the cache key. Only the full run gets a
		// token that writes it (src/turbo-cache.ts), so a PR's code can't leave a cache that vouches for files nobody
		// checked, not even with its TURBO_TOKEN.
		...(turbo && config.cache?.length && !config.install ? { CACHE_PATHS: config.cache.join("\n"), CACHE_API: turbo.api, CACHE_TOKEN: turbo.cacheToken, DEADLINE: String(job.startedAt + BOX_DEADLINE_MS) } : {}),
		// The install runs as root and the snapshot keeps the whole filesystem, so only the default branch's own code
		// (the daily full run) may produce one: a PR's lockfile, package manager config or install command could leave
		// anything in it for the runs after. PR runs only start from it.
		...(job.full && usesSnapshot(config) ? { SNAPSHOT: "1" } : {}),
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
	/** The instance type it ran on; DEFAULT_INSTANCE when missing. */
	instance?: string;
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
			? `The run took more than ${BOX_DEADLINE_MS / 60_000} minutes and the container was destroyed.`
			: "The container stopped before it finished (probably out of memory or disk).";
		await deps.publish(stopped(why, output), undefined, { wallMs, cpuUs: output.cpuUs });
		return "done";
	}
	const current = (await deps.read("current"))?.trim() ?? "";
	if (current !== "tests") {
		const status = STEP_STATUS[current] ?? "Starting the container";
		deps.status(`Container: ${status.toLowerCase()}`);
		const waiting = { title: "Waiting for the install", summary: `${status}. Then this command runs in the same container as the tests.` };
		await deps.progress({ tests: { title: status, summary: `${status}.` }, commands: job.commands.map(() => waiting) });
		return "poll";
	}
	const steps = parseSteps((await deps.read("steps")) ?? "");
	const step = (name: string) => steps.find((s) => s.name === name);
	const running = job.commands.findIndex((_, i) => !step(`command${i + 1}`));
	const runningNames = [...(step("tests") ? [] : ["the tests"]), ...(running >= 0 ? [job.commands[running].name] : [])];
	deps.status(`Container: running ${runningNames.join(" and ") || "the tests"}`);
	const counts = parseProgress(await deps.read("progress.json"));
	const commands = await Promise.all(
		job.commands.map(async ({ name }, i): Promise<BoxProgress["commands"][number]> => {
			const finished = step(`command${i + 1}`);
			if (finished) return deps.finished.has(i) ? undefined : commandResult(name, finished, await deps.read(`command${i + 1}.log`));
			if (i > running) return { title: `Waiting for ${job.commands[i - 1].name}`, summary: "The commands run one after another, in the same container as the tests." };
			return runningOutput(await deps.tail(`command${i + 1}.log`));
		}),
	);
	await deps.progress({ tests: testsOutput(counts, step("tests"), running >= 0 ? job.commands[running].name : undefined), commands, counts });
	return "poll";
}

const STEP_STATUS: Record<string, string> = {
	clone: "Downloading the code",
	install: "Installing the dependencies",
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
	const after = command ? `\n\nRunning now, in the same container: ${command}.` : "";
	if (!counts) return { title: "Running the tests", summary: `vitest is loading the tests.${after}` };
	const failed = counts.failed + counts.broken;
	const title = `${counts.passed} passed${failed ? `, ${failed} failed` : ""}${finished ? `; waiting for ${command ?? "the end"}` : ""}`;
	const lines = [
		finished ? "The tests finished. The result comes when the commands in the same container finish." : `Files: ${counts.filesDone} of ${counts.files}. Tests found so far: ${counts.tests}.`,
		`Passed ${counts.passed}, failed ${counts.failed}, skipped ${counts.skipped}${counts.broken ? `, files with errors outside the tests ${counts.broken}` : ""}.`,
	];
	const failures = counts.failures.map((f) => `**${f.file}${f.name ? ` › ${f.name}` : ""}**\n\n\`\`\`\n${fence(f.error)}\n\`\`\``);
	const more = failed > counts.failures.length ? [`… and ${failed - counts.failures.length} more ${failed - counts.failures.length === 1 ? "failure" : "failures"} in the final result.`] : [];
	return { title, summary: [...lines, ...(failures.length ? ["### Failures so far", ...failures, ...more] : [])].join("\n\n") + after };
}

/** What a running command's check run shows: the end of its log so far. */
export function runningOutput(tail: string | undefined): Pick<CheckResult, "title" | "summary"> {
	const log = (tail ?? "").trim();
	return { title: "Running", summary: log ? `End of the log so far:\n\n\`\`\`\n${fence(log)}\n\`\`\`` : "Running, no output yet." };
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
		const why = tests?.exitCode === TIMED_OUT ? `The tests went past the ${STEP_MINUTES}-minute limit.` : "vitest finished without writing the report.";
		return { ...results, tests: logFailure(why, output.logs.tests) };
	}
	if (!report.files.length) return { ...results, tests: changed ? NOTHING_AFFECTED : NO_TESTS };
	const result = toCheckResult(report);
	if (changed && result.conclusion === "success") result.title += ", only those affected by the PR";
	return { ...results, tests: result };
}

/** Results when the run stopped early: Container tests fails with why, and the commands that didn't finish didn't run. */
function stopped(why: string, output: BoxOutput): BoxResults {
	const log = [output.logs.clone, output.logs.install, output.logs.tests].filter(Boolean).join("\n");
	return { tests: logFailure(why, log), commands: [] };
}

function failedStep(name: "clone" | "install", step: Step | undefined): string {
	const what = name === "clone" ? "Could not download the code" : "Installing the dependencies failed";
	if (!step) return `${what}.`;
	return step.exitCode === TIMED_OUT ? `${what}: it timed out.` : `${what} (exit code ${step.exitCode}).`;
}

function commandResult(name: string, step: Step | undefined, log: string | undefined): CheckResult | undefined {
	if (!step) return undefined;
	if (step.exitCode === 0) return { conclusion: "success", title: `${name} passed`, summary: `No errors, in ${(step.ms / 1000).toFixed(0)} s.` };
	const why = step.exitCode === TIMED_OUT ? `${name} went past the ${STEP_MINUTES}-minute limit.` : `${name} failed (exit code ${step.exitCode}).`;
	return { ...logFailure(why, log), title: `${name} failed` };
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
			...(broken ? { errors: [file.message || "The file failed outside its tests."] } : {}),
			tests,
		};
	});
	return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Estimated price of a run's container. Memory and disk count for as long as it ran, CPU only as used. */
export function boxCost({ wallMs, cpuUs, instance }: BoxUsage): number {
	const seconds = wallMs / 1000;
	const size = instanceSize(instance);
	return (
		size.memoryGiB * seconds * CONTAINER_PRICES.memoryGiBs +
		size.diskGB * seconds * CONTAINER_PRICES.diskGBs +
		((cpuUs ?? 0) / 1_000_000) * CONTAINER_PRICES.vcpuS
	);
}

/** Usage goes in the run's test_container_runs row, created with the run (src/runs.ts). */
async function recordUsage(db: D1Database, job: BoxJob, usage: BoxUsage): Promise<void> {
	await db
		.prepare("UPDATE test_container_runs SET instance = ?, wall_ms = ?, cpu_us = ? WHERE run_id = ?")
		.bind(job.instance ?? DEFAULT_INSTANCE, usage.wallMs, usage.cpuUs ?? null, job.runId)
		.run()
		.catch(logError);
}

/** A run's container usage, for the admin; undefined for runs that didn't use a container or are still going. */
export async function containerUsage(db: D1Database, runId: number): Promise<BoxUsage | undefined> {
	const row = await db
		.prepare("SELECT instance, wall_ms, cpu_us FROM test_container_runs WHERE run_id = ? AND wall_ms IS NOT NULL")
		.bind(runId)
		.first<{ instance: string | null; wall_ms: number; cpu_us: number | null }>();
	return row ? { wallMs: row.wall_ms, cpuUs: row.cpu_us ?? undefined, instance: row.instance ?? DEFAULT_INSTANCE } : undefined;
}

const COMMAND_CANCELLED: CheckResult = {
	conclusion: "cancelled",
	title: "Cancelled",
	summary: "The run was cancelled (by a newer push) or ran out of time before this command finished.",
};

const NOT_RUN: CheckResult = {
	conclusion: "neutral",
	title: "Did not run",
	summary: "The container stopped before it got to this command. The Container tests check says why.",
};

const NO_TESTS: CheckResult = {
	conclusion: "neutral",
	title: "No tests found",
	summary: "The repository's vitest found no test files.",
};

const NOTHING_AFFECTED: CheckResult = {
	conclusion: "success",
	title: "No tests affected by the PR",
	summary: "No test file depends on what the PR changed (`vitest --changed`). The daily full run on the main branch runs them all.",
};

function logError(error: unknown): undefined {
	// Workers Logs keeps an Error's stack but not its message, which says what GitHub answered.
	console.error("quality-flare: container run", error instanceof Error ? `${error.message}\n${error.stack}` : error);
	return undefined;
}
