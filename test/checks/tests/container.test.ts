import { describe, expect, it, vi } from "vitest";
import { readContainerConfig } from "../../../src/checks/tests/config.ts";
import {
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
} from "../../../src/checks/tests/container.ts";
import { tests } from "../../../src/checks/tests/index.ts";
import { d1JobStore } from "../../../src/checks/tests/jobs.ts";
import type { GitHubClient, PullRequest } from "../../../src/github.ts";
import { d1RunStore } from "../../../src/runs.ts";
import { fakeD1 } from "../../fake-d1.ts";

const pr = { number: 7, head: { sha: "abc" } } as PullRequest;

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

	it("fails with the install log when dependencies don't install, and leaves Typecheck neutral", () => {
		const results = boxResults(output("clone 0 900\ninstall 1 30000\n", { logs: { install: "npm ERR! missing lockfile" } }));
		expect(results.tests).toMatchObject({ conclusion: "failure", title: "A instalação das dependências falhou (código de saída 1)" });
		expect(results.tests.summary).toContain("npm ERR! missing lockfile");
		expect(results.typecheck).toMatchObject({ conclusion: "neutral" });
	});

	it("reports the tests and the typecheck separately", () => {
		const results = boxResults(
			output("clone 0 900\ninstall 0 40000\ntests 1 140000\ntypecheck 2 28000\n", { report: REPORT, logs: { typecheck: "src/x.ts(1,1): error TS2322" } }),
		);
		expect(results.tests).toMatchObject({ conclusion: "failure", title: "2 falhas em 3 testes" });
		expect(results.typecheck).toMatchObject({ conclusion: "failure", title: "Typecheck falhou" });
		expect(results.typecheck?.summary).toContain("error TS2322");
	});

	it("passes when every test passes, and has no Typecheck result without a typecheck step", () => {
		const report = JSON.stringify({ testResults: [{ name: "/work/repo/a.test.ts", status: "passed", assertionResults: [{ title: "ok", status: "passed" }] }] });
		const results = boxResults(output("clone 0 1\ninstall 0 1\ntests 0 1\n", { report }));
		expect(results.tests).toMatchObject({ conclusion: "success", title: "1 teste passaram" });
		expect(results.typecheck).toBeUndefined();
	});

	it("fails with the log when the tests time out", () => {
		const results = boxResults(output("clone 0 1\ninstall 0 1\ntests 124 1500000\n", { logs: { tests: "····" } }));
		expect(results.tests).toMatchObject({ conclusion: "failure", title: "Os testes passaram do limite de 25 minutos" });
	});

	describe("TestBox polling", () => {
		const job: BoxJob = { runId: 1, repo: "octo/app", sha: "abc", installationId: 9, checkRunId: 55, typecheckCheckRunId: 56, startedAt: 0 };
		function deps(files: Record<string, string>, { now = 60_000, running = true, job: open = true } = {}) {
			const d = {
				now: () => now,
				running: () => running,
				read: async (path: string) => files[path],
				jobs: { get: async () => (open ? { checkRunId: 55, installationId: 9 } : null) },
				status: vi.fn<PollDeps["status"]>(),
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

		it("publishes once the container is done, with its usage", async () => {
			const d = deps({ done: "done\n", steps: "clone 0 1\ninstall 0 1\ntests 1 1\n", "report.json": REPORT, cpu: "635000000\n" });
			expect(await pollBox(job, d)).toBe("done");
			const [results, report, usage] = d.publish.mock.calls[0];
			expect(results.tests.conclusion).toBe("failure");
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

	it("passes its config to the container, one vitest argument per line", () => {
		expect(boxEnv({ repo: "octo/app", sha: "abc" }, { vitestArgs: ["--config", "vitest.unit.config.mts"], typecheck: "npm run typecheck" }, "t")).toEqual({
			REPO: "octo/app",
			SHA: "abc",
			TOKEN: "t",
			VITEST_ARGS: "--config\nvitest.unit.config.mts",
			TYPECHECK: "npm run typecheck",
		});
	});

	it("reads the container section of quality-flare.json apart from the tests section", () => {
		const json = JSON.stringify({ tests: { include: ["src/**/*.test.ts"] }, container: { vitestArgs: ["--project", "node"], typecheck: "tsc" } });
		expect(readContainerConfig(json)).toEqual({ vitestArgs: ["--project", "node"], typecheck: "tsc" });
		expect(readContainerConfig(undefined)).toEqual({});
		expect(() => readContainerConfig(JSON.stringify({ container: { vitestArgs: "--project node" } }))).toThrow(/vitestArgs/);
		expect(() => readContainerConfig(JSON.stringify({ container: { typecheck: true } }))).toThrow(/typecheck/);
	});

	it("estimates about two cents for the run measured on macae", () => {
		// npm ci + vitest + typecheck: 225 s on a standard-4, 635 vCPU-seconds.
		expect(boxCost({ wallMs: 225_000, cpuUs: 635_000_000 })).toBeCloseTo(0.0198, 3);
	});

	it("starts the check runs, the job and the container", async () => {
		const RUNS = await fakeD1();
		const startCheckRun = vi.fn(async (_repo: string, _sha: string, name: string) => (name === "Typecheck" ? 56 : 55));
		const config = JSON.stringify({ container: { typecheck: "npm run typecheck" } });
		const github = { getFileText: async () => config, startCheckRun } as unknown as GitHubClient;
		const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
		const TEST_BOX = { idFromName: (name: string) => name, get: () => ({ fetch }) };
		const env = { RUNS, TEST_BOX, PUBLIC_URL: "https://qf.example" } as unknown as Env;

		expect(await containerTests.run({ github, repo: "octo/app", pr, env, installationId: 9 })).toBeNull();
		const [run] = await d1RunStore(RUNS).list();
		expect(startCheckRun).toHaveBeenCalledWith("octo/app", "abc", "Container tests", "Rodando os testes num container", `https://qf.example/admin/runs/${run.id}`);
		expect(startCheckRun).toHaveBeenCalledWith("octo/app", "abc", "Typecheck", "Rodando o typecheck num container", `https://qf.example/admin/runs/${run.id}`);
		expect(await d1JobStore(RUNS).get(run.id)).toMatchObject({ checkRunId: 55, installationId: 9 });
		const body = JSON.parse(String(fetch.mock.calls[0][1].body));
		expect(body).toMatchObject({ job: { runId: run.id, checkRunId: 55, typecheckCheckRunId: 56 }, config: { typecheck: "npm run typecheck" } });
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
