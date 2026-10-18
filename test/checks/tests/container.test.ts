import { describe, expect, it, vi } from "vitest";
import { readContainerConfig } from "../../../src/checks/tests/config.ts";
import {
	alertFullRun,
	BOX_DEADLINE_MS,
	boxCost,
	boxEnv,
	boxResults,
	containerTests,
	parseSteps,
	parseVitestReport,
	pollBox,
	type BoxJob,
	type BoxOutput,
	type PollDeps,
	type TestProgress,
} from "../../../src/checks/tests/container.ts";
import { tests } from "../../../src/checks/tests/index.ts";
import { d1JobStore } from "../../../src/checks/tests/jobs.ts";
import type { GitHubClient, PullRequest } from "../../../src/github.ts";
import { d1RunStore } from "../../../src/runs.ts";
import { fakeD1 } from "../../fake-d1.ts";

// fakeD1 needs Node's sqlite, which the Workers runtime (quality-flare's own Tests check) doesn't have.
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";

const pr = { number: 7, head: { sha: "abc" }, base: { ref: "main" } } as PullRequest;

/** vitest's JSON reporter, trimmed to what quality-flare reads. */
const REPORT = JSON.stringify({
	testResults: [
		{
			name: "/work/repo/src/b.test.ts",
			status: "failed",
			message: "",
			assertionResults: [
				{ ancestorTitles: ["sum"], title: "adds", status: "passed", failureMessages: [] },
				{ ancestorTitles: ["sum"], title: "carries", status: "failed", failureMessages: ["AssertionError: expected 3 to be 4"] },
				{ ancestorTitles: [], title: "later", status: "todo", failureMessages: [] },
			],
		},
		{ name: "/work/repo/src/a.test.ts", status: "failed", message: "Error: Cannot find module './gone'", assertionResults: [] },
	],
});

const output = (steps: string, extra: Partial<BoxOutput> = {}): BoxOutput => ({ steps: parseSteps(steps), logs: {}, ...extra });

describe("Container tests", () => {
	it("reads vitest's JSON report as the report the Dynamic Workers runner makes", () => {
		expect(parseVitestReport(REPORT)).toEqual({
			files: [
				{ path: "src/a.test.ts", state: "fail", errors: ["Error: Cannot find module './gone'"], tests: [] },
				{
					path: "src/b.test.ts",
					state: "fail",
					tests: [
						{ name: "sum › adds", state: "pass" },
						{ name: "sum › carries", state: "fail", errors: ["AssertionError: expected 3 to be 4"] },
						{ name: "later", state: "todo" },
					],
				},
			],
		});
		expect(parseVitestReport("not json")).toBeUndefined();
	});

	const commands = [{ name: "Typecheck" }, { name: "Lint" }];

	it("fails with the install log when dependencies don't install, and runs no command", () => {
		const results = boxResults(output("clone 0 900\ninstall 1 30000\n", { logs: { install: "npm ERR! missing lockfile" } }), commands);
		expect(results.tests).toMatchObject({ conclusion: "failure", title: "A instalação das dependências falhou (código de saída 1)" });
		expect(results.tests.summary).toContain("npm ERR! missing lockfile");
		expect(results.commands).toEqual([]);
	});

	it("reports the tests and each command separately", () => {
		const results = boxResults(
			output("clone 0 900\ninstall 0 40000\ntests 1 140000\ncommand1 2 28000\ncommand2 0 121000\n", {
				report: REPORT,
				logs: { command1: "src/x.ts(1,1): error TS2322" },
			}),
			commands,
		);
		expect(results.tests).toMatchObject({ conclusion: "failure", title: "2 falhas em 3 testes" });
		expect(results.commands[0]).toMatchObject({ conclusion: "failure", title: "Typecheck falhou" });
		expect(results.commands[0]?.summary).toContain("error TS2322");
		expect(results.commands[1]).toMatchObject({ conclusion: "success", title: "Lint passou", summary: "Sem erros, em 121 s." });
	});

	it("passes when every test passes, and leaves out a command that didn't run", () => {
		const report = JSON.stringify({ testResults: [{ name: "/work/repo/a.test.ts", status: "passed", assertionResults: [{ title: "ok", status: "passed" }] }] });
		const results = boxResults(output("clone 0 1\ninstall 0 1\ntests 0 1\ncommand1 124 1200000\n", { report }), commands);
		expect(results.tests).toMatchObject({ conclusion: "success", title: "1 teste passaram" });
		expect(results.commands).toEqual([expect.objectContaining({ title: "Typecheck falhou", summary: "Typecheck passou do limite de 15 minutos." }), undefined]);
	});

	it("says when only the PR's affected tests ran, and passes when none were affected", () => {
		const report = JSON.stringify({ testResults: [{ name: "/work/repo/a.test.ts", status: "passed", assertionResults: [{ title: "ok", status: "passed" }] }] });
		expect(boxResults(output("clone 0 1\ninstall 0 1\ntests 0 1\n", { report }), [], true).tests.title).toBe("1 teste passaram, só os afetados pela PR");
		const none = output("clone 0 1\ninstall 0 1\ntests 0 1\n", { report: JSON.stringify({ testResults: [] }) });
		expect(boxResults(none, [], true).tests).toMatchObject({ conclusion: "success", title: "Nenhum teste afetado pela PR" });
		expect(boxResults(none).tests).toMatchObject({ conclusion: "neutral", title: "Nenhum teste encontrado" });
	});

	it("opens an issue when the daily full run fails, naming what failed", async () => {
		const job: BoxJob = { runId: 3, repo: "octo/app", sha: "abcdef123", base: "main", installationId: 9, checkRunId: 1, commands: [{ name: "Lint", checkRunId: 2 }], startedAt: 0, full: true };
		const createIssue = vi.fn(async () => "https://github.com/octo/app/issues/1");
		const passed = { conclusion: "success", title: "ok", summary: "" } as const;
		expect(await alertFullRun({ createIssue }, job, { tests: passed, commands: [passed] }, "https://qf/admin/runs/3")).toBeUndefined();
		expect(createIssue).not.toHaveBeenCalled();
		await alertFullRun({ createIssue }, job, { tests: passed, commands: [{ conclusion: "failure", title: "Lint falhou", summary: "" }] }, "https://qf/admin/runs/3");
		const [repo, title, body] = createIssue.mock.calls[0] as unknown as string[];
		expect([repo, title]).toEqual(["octo/app", "A run completa de main falhou em abcdef1"]);
		expect(body).toContain("- **Lint**: Lint falhou");
		expect(body).toContain("https://qf/admin/runs/3");
	});

	it("fails with the log when the tests time out", () => {
		const results = boxResults(output("clone 0 1\ninstall 0 1\ntests 124 1500000\n", { logs: { tests: "····" } }));
		expect(results.tests).toMatchObject({ conclusion: "failure", title: "Os testes passaram do limite de 15 minutos" });
	});

	describe("TestBox polling", () => {
		const job: BoxJob = { runId: 1, repo: "octo/app", sha: "abc", base: "main", installationId: 9, checkRunId: 55, commands: [{ name: "Lint", checkRunId: 56 }], startedAt: 0 };
		function deps(files: Record<string, string>, { now = 60_000, running = true, job: open = true, finished = [] as number[] } = {}) {
			const d = {
				now: () => now,
				running: () => running,
				read: async (path: string) => files[path],
				tail: async (path: string) => files[path],
				jobs: { get: async () => (open ? { checkRunId: 55, installationId: 9 } : null) },
				finished: new Set(finished),
				status: vi.fn<PollDeps["status"]>(),
				progress: vi.fn<PollDeps["progress"]>(async () => {}),
				publish: vi.fn<PollDeps["publish"]>(async () => {}),
				abandon: vi.fn<PollDeps["abandon"]>(async () => {}),
			};
			return d;
		}

		it("shows the step running and looks again later", async () => {
			const d = deps({ current: "install\n" });
			expect(await pollBox(job, d)).toBe("poll");
			expect(d.status).toHaveBeenCalledWith("Container: instalando as dependências");
		});

		it("names the tests and commands still running", async () => {
			const d = deps({ current: "tests\n" });
			await pollBox(job, d);
			expect(d.status).toHaveBeenCalledWith("Container: rodando os testes e Lint");
		});

		it("leaves out what already finished", async () => {
			const d = deps({ current: "tests\n", steps: "clone 0 1\ninstall 0 1\ntests 0 1\n" });
			await pollBox(job, d);
			expect(d.status).toHaveBeenCalledWith("Container: rodando Lint");
		});

		const progress = (p: Partial<TestProgress>) => JSON.stringify({ files: 3, filesDone: 1, tests: 10, passed: 4, failed: 0, skipped: 1, broken: 0, failures: [], ...p });
		const twoCommands: BoxJob = { ...job, commands: [{ name: "Typecheck", checkRunId: 56 }, { name: "Lint", checkRunId: 57 }] };

		it("shows the step running on every check run while it installs", async () => {
			const d = deps({ current: "install\n" });
			await pollBox(twoCommands, d);
			const [shown] = d.progress.mock.calls[0];
			expect(shown.tests.title).toBe("Instalando as dependências");
			expect(shown.commands.map((c) => c?.title)).toEqual(["Esperando a instalação", "Esperando a instalação"]);
		});

		it("shows the tests so far with their failures, the running command's log and the next one waiting", async () => {
			const failures = [{ file: "src/a.test.ts", name: "sum › carries", error: "AssertionError: expected 3 to be 4" }];
			const d = deps({ current: "tests\n", "progress.json": progress({ failed: 1, failures }), "command1.log": "line 1\nchecking src/index.ts" });
			await pollBox(twoCommands, d);
			const [shown] = d.progress.mock.calls[0];
			expect(shown.tests.title).toBe("4 passaram, 1 falhou");
			expect(shown.tests.summary).toContain("Arquivos: 1 de 3");
			expect(shown.tests.summary).toContain("**src/a.test.ts › sum › carries**");
			expect(shown.tests.summary).toContain("AssertionError: expected 3 to be 4");
			expect(shown.tests.summary).toContain("Rodando agora, no mesmo container: Typecheck.");
			expect(shown.commands[0]).toMatchObject({ title: "Rodando" });
			expect(shown.commands[0]?.summary).toContain("checking src/index.ts");
			expect(shown.commands[1]).toMatchObject({ title: "Esperando Typecheck" });
			expect(shown.counts).toMatchObject({ passed: 4, failed: 1 });
		});

		it("completes a command as soon as it finishes, only once", async () => {
			const files = { current: "tests\n", steps: "clone 0 1\ninstall 0 1\ncommand1 2 3000\n", "command1.log": "src/a.ts: error TS2304" };
			const d = deps(files);
			await pollBox(twoCommands, d);
			const [shown] = d.progress.mock.calls[0];
			expect(shown.commands[0]).toMatchObject({ conclusion: "failure", title: "Typecheck falhou" });
			expect(shown.commands[0]?.summary).toContain("error TS2304");
			expect(shown.commands[1]).toMatchObject({ title: "Rodando" });
			const again = deps(files, { finished: [0] });
			await pollBox(twoCommands, again);
			expect(again.progress.mock.calls[0][0].commands[0]).toBeUndefined();
		});

		it("says the tests finished and wait for the commands", async () => {
			const d = deps({ current: "tests\n", steps: "clone 0 1\ninstall 0 1\ntests 0 1\n", "progress.json": progress({ filesDone: 3, passed: 9 }) });
			await pollBox(twoCommands, d);
			expect(d.progress.mock.calls[0][0].tests.title).toBe("9 passaram; esperando Typecheck");
		});

		it("publishes once the container is done, with its usage", async () => {
			const d = deps({ done: "done\n", steps: "clone 0 1\ninstall 0 1\ntests 1 1\ncommand1 1 1\n", "report.json": REPORT, "command1.log": "lint error", cpu: "635000000\n" });
			expect(await pollBox(job, d)).toBe("done");
			const [results, report, usage] = d.publish.mock.calls[0];
			expect(results.tests.conclusion).toBe("failure");
			expect(results.commands[0]?.summary).toContain("lint error");
			expect(report?.files).toHaveLength(2);
			expect(usage).toEqual({ wallMs: 60_000, cpuUs: 635_000_000 });
		});

		it("stops without publishing when a newer push or the sweep closed the run", async () => {
			const d = deps({}, { job: false });
			expect(await pollBox(job, d)).toBe("done");
			expect(d.abandon).toHaveBeenCalled();
			expect(d.publish).not.toHaveBeenCalled();
		});

		it("fails the run when the container stopped, or past the deadline", async () => {
			const stopped = deps({}, { running: false });
			expect(await pollBox(job, stopped)).toBe("done");
			expect(stopped.publish.mock.calls[0][0].tests.title).toBe("O container parou antes de terminar (falta de memória ou de disco, provavelmente)");
			const late = deps({}, { now: BOX_DEADLINE_MS + 1 });
			expect(await pollBox(job, late)).toBe("done");
			expect(late.publish.mock.calls[0][0].tests.conclusion).toBe("failure");
		});
	});

	it("passes its config to the container, one vitest argument per line and the typecheck first", () => {
		const config = { vitestArgs: ["--config", "vitest.unit.config.mts"], typecheck: "npm run typecheck", commands: { Lint: "npm run lint" } };
		expect(boxEnv({ repo: "octo/app", sha: "abc", base: "main" }, config, "t")).toEqual({
			REPO: "octo/app",
			SHA: "abc",
			BASE: "main",
			TOKEN: "t",
			VITEST_ARGS: "--config\nvitest.unit.config.mts",
			COMMANDS: "2",
			COMMAND_1: "npm run typecheck",
			COMMAND_2: "npm run lint",
		});
	});

	it("tells the container to run only the affected tests, or everything on a full run", () => {
		const job = { repo: "octo/app", sha: "abc", base: "main" };
		expect(boxEnv({ ...job, changed: true }, { changed: true }, "t")).toMatchObject({ CHANGED: "1" });
		expect(boxEnv({ ...job, changed: true }, { changed: true, alwaysRun: ["bin/", "src/a.test.ts"] }, "t")).toMatchObject({ ALWAYS_RUN: "bin/\nsrc/a.test.ts" });
		expect(boxEnv({ ...job, full: true }, { changed: true, alwaysRun: ["bin/"] }, "t")).not.toHaveProperty("ALWAYS_RUN");
		expect(boxEnv({ ...job, full: true }, { changed: true }, "t")).toMatchObject({ FULL: "1" });
		expect(boxEnv({ ...job, full: true }, { changed: true }, "t")).not.toHaveProperty("CHANGED");
		expect(boxEnv(job, {}, "t")).not.toHaveProperty("CHANGED");
	});

	it("points Turborepo at the repository's remote cache, which a full run doesn't trust", () => {
		const job = { repo: "octo/app", sha: "abc", base: "main" };
		const turbo = { api: "https://qf.example/turbo", token: "tt" };
		expect(boxEnv(job, { turboCache: true }, "t", turbo)).toMatchObject({ TURBO_API: "https://qf.example/turbo", TURBO_TEAM: "quality-flare", TURBO_TOKEN: "tt" });
		expect(boxEnv(job, { turboCache: true }, "t", turbo)).not.toHaveProperty("TURBO_FORCE");
		expect(boxEnv({ ...job, full: true }, { turboCache: true }, "t", turbo)).toMatchObject({ TURBO_FORCE: "true" });
		expect(boxEnv(job, {}, "t")).not.toHaveProperty("TURBO_API");
	});

	it("gives the container the paths its runs keep, apart from Turborepo's cache", () => {
		const job = { repo: "octo/app", sha: "abc", base: "main" };
		const turbo = { api: "https://qf.example/turbo", token: "tt" };
		const cache = [".cache/eslint", "tsconfig.tsbuildinfo"];
		expect(boxEnv(job, { cache }, "t", turbo)).toMatchObject({ CACHE_PATHS: ".cache/eslint\ntsconfig.tsbuildinfo", CACHE_API: "https://qf.example/turbo", CACHE_TOKEN: "tt" });
		expect(boxEnv(job, { cache }, "t", turbo)).not.toHaveProperty("TURBO_API");
		expect(boxEnv(job, { turboCache: true }, "t", turbo)).not.toHaveProperty("CACHE_PATHS");
	});

	it("tells the container when its install may become the repository's snapshot", () => {
		const job = { repo: "octo/app", sha: "abc", base: "main" };
		expect(boxEnv(job, { snapshot: true }, "t")).toMatchObject({ SNAPSHOT: "1" });
		expect(boxEnv(job, {}, "t")).not.toHaveProperty("SNAPSHOT");
	});

	it("reads the container section of quality-flare.json apart from the tests section", () => {
		const container = { vitestArgs: ["--project", "node"], typecheck: "tsc", commands: { Lint: "eslint .", "Web Workers": "turbo run test" } };
		const json = JSON.stringify({ tests: { include: ["src/**/*.test.ts"] }, container });
		expect(readContainerConfig(json)).toEqual(container);
		expect(readContainerConfig(undefined)).toEqual({});
		const invalid = (container: unknown) => () => readContainerConfig(JSON.stringify({ container }));
		expect(invalid({ vitestArgs: "--project node" })).toThrow(/vitestArgs/);
		expect(invalid({ typecheck: true })).toThrow(/typecheck/);
		expect(invalid({ changed: "yes" })).toThrow(/"container.changed" deve ser true ou false/);
		expect(invalid({ alwaysRun: "bin/" })).toThrow(/"container.alwaysRun" deve ser uma lista/);
		expect(invalid({ turboCache: 1 })).toThrow(/"container.turboCache" deve ser true ou false/);
		expect(invalid({ snapshot: "yes" })).toThrow(/"container.snapshot" deve ser true ou false/);
		expect(invalid({ cache: ".eslintcache" })).toThrow(/"container.cache" deve ser uma lista/);
		expect(invalid({ cache: ["/etc"] })).toThrow(/dentro do repositório/);
		expect(invalid({ cache: ["a/../../b"] })).toThrow(/dentro do repositório/);
		expect(readContainerConfig(JSON.stringify({ container: { cache: ["node_modules/.cache/eslint"] } }))).toEqual({ cache: ["node_modules/.cache/eslint"] });
		expect(readContainerConfig(JSON.stringify({ container: { changed: true, turboCache: true } }))).toEqual({ changed: true, turboCache: true });
		expect(invalid({ commands: ["npm run lint"] })).toThrow(/"container.commands" deve ligar/);
		expect(invalid({ commands: { Lint: 1 } })).toThrow(/"container.commands" deve ligar/);
		expect(invalid({ commands: { " ": "x" } })).toThrow(/não serve de nome/);
		expect(invalid({ typecheck: "tsc", commands: { typecheck: "tsc" } })).toThrow(/não repita/);
		expect(invalid({ commands: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, "x"])) })).toThrow(/até 8/);
	});

	it("estimates about two cents for the run measured on macae", () => {
		// npm ci + vitest + typecheck: 225 s on a standard-4, 635 vCPU-seconds.
		expect(boxCost({ wallMs: 225_000, cpuUs: 635_000_000 })).toBeCloseTo(0.0198, 3);
	});

	describe.skipIf(inWorkers)("with D1", () => {
		it("starts the check runs, the job and the container", async () => {
			const RUNS = await fakeD1();
			const ids: Record<string, number> = { "Container tests": 55, Typecheck: 56, Lint: 57 };
			const startCheckRun = vi.fn(async (_repo: string, _sha: string, name: string) => ids[name]);
			const config = JSON.stringify({ container: { typecheck: "npm run typecheck", commands: { Lint: "npm run lint" }, changed: true } });
			const github = { getFileText: async () => config, startCheckRun } as unknown as GitHubClient;
			const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
			const TEST_BOX = { idFromName: (name: string) => name, get: () => ({ fetch }) };
			const env = { RUNS, PUBLIC_URL: "https://qf.example" } as unknown as Env;
			// The Worker's own exports, where containerTests finds TestBox (test/cloudflare-workers.ts under Node).
			(await import("cloudflare:workers")).exports.TestBox = TEST_BOX;

			expect(await containerTests.run({ github, repo: "octo/app", pr, env, installationId: 9 })).toBeNull();
			const [run] = await d1RunStore(RUNS).list();
			expect(startCheckRun).toHaveBeenCalledWith("octo/app", "abc", "Container tests", "Rodando os testes num container", `https://qf.example/admin/runs/${run.id}`);
			expect(startCheckRun).toHaveBeenCalledWith("octo/app", "abc", "Lint", "Esperando os testes, no mesmo container", `https://qf.example/admin/runs/${run.id}`);
			expect(await d1JobStore(RUNS).get(run.id)).toMatchObject({ checkRunId: 55, installationId: 9 });
			const body = JSON.parse(String(fetch.mock.calls[0][1].body));
			expect(body.job).toMatchObject({
				runId: run.id,
				base: "main",
				changed: true,
				checkRunId: 55,
				commands: [
					{ name: "Typecheck", checkRunId: 56 },
					{ name: "Lint", checkRunId: 57 },
				],
			});
		});

		it("uses the base branch's config when the PR has none", async () => {
			const RUNS = await fakeD1();
			const getFileText = vi.fn(async (_repo: string, ref: string) => (ref === "main" ? JSON.stringify({ container: { vitestArgs: ["--config", "unit.mts"] } }) : undefined));
			const github = { getFileText, startCheckRun: async () => 55 } as unknown as GitHubClient;
			const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
			(await import("cloudflare:workers")).exports.TestBox = { idFromName: (name: string) => name, get: () => ({ fetch }) };
			const env = { RUNS, PUBLIC_URL: "https://qf.example" } as unknown as Env;

			await containerTests.run({ github, repo: "octo/app", pr, env, installationId: 9 });
			expect(getFileText.mock.calls.map(([, ref]) => ref)).toEqual(["abc", "main"]);
			expect(JSON.parse(String(fetch.mock.calls[0][1].body)).config).toEqual({ vitestArgs: ["--config", "unit.mts"] });
		});

		it("doesn't cancel the PR's Tests run, nor does a Tests run cancel it", async () => {
			const RUNS = await fakeD1();
			const runs = d1RunStore(RUNS);
			const workers = await runs.start({ repo: "octo/app", pr: 7, sha: "a" });
			const container = await runs.start({ repo: "octo/app", pr: 7, sha: "a", container: true });
			const newerWorkers = await runs.start({ repo: "octo/app", pr: 7, sha: "b" });
			const newerContainer = await runs.start({ repo: "octo/app", pr: 7, sha: "b", container: true });
			expect(await runs.running("octo/app", 7, newerWorkers)).toEqual([workers]);
			expect(await runs.running("octo/app", 7, newerContainer)).toEqual([container]);
			// The Tests check itself is unchanged.
			expect(tests.id).toBe("tests");
		});
	});
});
