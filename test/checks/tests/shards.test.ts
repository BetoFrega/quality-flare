import { describe, expect, it, vi } from "vitest";
import { Crashed, MAX_CODE_BYTES, processShard, RUN_DEADLINE_MS, SHARD_SIZE, tests, TooLarge, type ShardDeps } from "../../../src/checks/tests/index.ts";
import { d1JobStore, type ShardResult, type TestShard } from "../../../src/checks/tests/jobs.ts";
import type { GitHubClient, PullRequest } from "../../../src/github.ts";
import { d1RunStore } from "../../../src/runs.ts";
import { fakeD1 } from "../../fake-d1.ts";

const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const pr = { number: 7, body: null, head: { sha: "abc" }, labels: [] } as unknown as PullRequest;

const passing = (files: string[]): ShardResult => ({
	report: { files: files.map((path) => ({ path, state: "pass", tests: [{ name: `${path} works`, state: "pass" }] })) },
	unresolved: [],
});

function shard(files: string[], id = "0"): TestShard {
	return { runId: 1, shard: id, repo: "octo/app", installationId: 9, sha: "abc", files };
}

/** Runs queued shards until the queue is empty, like the consumer would. */
async function drain(queue: { shard: TestShard; attempts: number }[], deps: ShardDeps) {
	while (queue.length) {
		const { shard, attempts } = queue.shift()!;
		await processShard(shard, attempts, deps);
	}
}

// node:sqlite stands in for D1, so this only runs under Node.
describe.skipIf(inWorkers)("Tests check shards", () => {
	async function setup(shards: number, run: ShardDeps["run"]) {
		const jobs = d1JobStore(await fakeD1());
		await jobs.create(1, { shards, checkRunId: 55, installationId: 9 });
		const queue: { shard: TestShard; attempts: number }[] = [];
		const publish = vi.fn<ShardDeps["publish"]>(async () => {});
		const deps: ShardDeps = { jobs, run, publish, enqueue: async (s) => void queue.push(...s.map((shard) => ({ shard, attempts: 1 }))) };
		return { jobs, queue, publish, deps };
	}

	it("queues the test files in shards and leaves the check run to them", async () => {
		const RUNS = await fakeD1();
		const files = Array.from({ length: SHARD_SIZE + 5 }, (_, i) => `test/t${String(i).padStart(2, "0")}.test.ts`);
		const startCheckRun = vi.fn(async () => 55);
		const github = { listFiles: async () => [...files, "src/a.ts", "README.md"], getFileText: async () => undefined, startCheckRun } as unknown as GitHubClient;
		const sendBatch = vi.fn(async () => {});
		const env = { RUNS, TESTS_QUEUE: { sendBatch }, PUBLIC_URL: "https://qf.example" } as unknown as Env;

		expect(await tests.run({ github, repo: "octo/app", pr, env, installationId: 9 })).toBeNull();
		const bodies = (sendBatch.mock.calls[0] as unknown as [{ body: TestShard }[]])[0].map((m) => m.body);
		// "View more details" on GitHub opens this run in the admin.
		expect(startCheckRun).toHaveBeenCalledWith("octo/app", "abc", "Tests", `Rodando ${SHARD_SIZE + 5} arquivos de teste`, `https://qf.example/admin/runs/${bodies[0].runId}`);
		expect(bodies.map((b) => [b.shard, b.files.length])).toEqual([["0", SHARD_SIZE], ["1", 5]]);
		expect(bodies[0]).toMatchObject({ repo: "octo/app", sha: "abc", installationId: 9 });
		expect(await d1JobStore(RUNS).get(bodies[0].runId)).toEqual({ checkRunId: 55, installationId: 9, startedAt: expect.any(Number) });
	});

	it("runs the files quality-flare.json includes, and hands its config to every shard", async () => {
		const RUNS = await fakeD1();
		const config = { include: ["src/**/*.test.{ts,tsx}"], exclude: ["**/*.integration.test.ts"], setupFiles: ["setup.ts"], globals: true };
		const github = {
			listFiles: async () => ["src/a.test.ts", "src/b.test.tsx", "src/c.integration.test.ts", "test/d.test.ts"],
			getFileText: async (_repo: string, _ref: string, path: string) => (path === "quality-flare.json" ? JSON.stringify({ tests: config }) : undefined),
			startCheckRun: async () => 55,
		} as unknown as GitHubClient;
		const sendBatch = vi.fn(async () => {});
		const env = { RUNS, TESTS_QUEUE: { sendBatch }, PUBLIC_URL: "https://qf.example" } as unknown as Env;

		await tests.run({ github, repo: "octo/app", pr, env, installationId: 9 });
		const [body] = (sendBatch.mock.calls[0] as unknown as [{ body: TestShard }[]])[0].map((m) => m.body);
		expect(body).toMatchObject({ files: ["src/a.test.ts", "src/b.test.tsx"], config });
	});

	it("cancels the PR's run still going when a newer push starts one, and its queued shards drop", async () => {
		const RUNS = await fakeD1();
		let nextCheckRun = 55;
		const completeCheckRun = vi.fn(async () => {});
		const github = {
			listFiles: async () => ["test/a.test.ts"],
			getFileText: async () => undefined,
			startCheckRun: async () => nextCheckRun++,
			completeCheckRun,
		} as unknown as GitHubClient;
		const sendBatch = vi.fn(async () => {});
		const env = { RUNS, TESTS_QUEUE: { sendBatch }, PUBLIC_URL: "https://qf.example" } as unknown as Env;
		const bodies = () => (sendBatch.mock.calls.at(-1) as unknown as [{ body: TestShard }[]])[0].map((m) => m.body);

		await tests.run({ github, repo: "octo/app", pr, env, installationId: 9 });
		const [old] = bodies();
		await tests.run({ github, repo: "octo/app", pr: { ...pr, head: { sha: "def" } } as PullRequest, env, installationId: 9 });

		expect(completeCheckRun).toHaveBeenCalledExactlyOnceWith("octo/app", 55, expect.objectContaining({ conclusion: "cancelled" }));
		const [newer, cancelled] = await d1RunStore(RUNS).list();
		expect([newer.status, cancelled]).toEqual(["running", expect.objectContaining({ id: old.runId, status: "completed", conclusion: "cancelled" })]);
		const run = vi.fn<ShardDeps["run"]>(async (s) => passing(s.files));
		const publish = vi.fn<ShardDeps["publish"]>(async () => {});
		await processShard(old, 1, { jobs: d1JobStore(RUNS), run, publish, enqueue: async () => {} });
		expect(run).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it("stops a run past its deadline: queued shards report their files without running them", async () => {
		const RUNS = await fakeD1();
		const runs = d1RunStore(RUNS, () => 0);
		const runId = await runs.start({ repo: "octo/app", pr: 7, sha: "abc" });
		const jobs = d1JobStore(RUNS);
		await jobs.create(runId, { shards: 1, checkRunId: 55, installationId: 9 });
		const run = vi.fn<ShardDeps["run"]>(async (s) => passing(s.files));
		const publish = vi.fn<ShardDeps["publish"]>(async () => {});
		await processShard({ ...shard(["test/a.test.ts"]), runId }, 2, { jobs, run, publish, enqueue: async () => {}, now: () => RUN_DEADLINE_MS + 1 });
		expect(run).not.toHaveBeenCalled();
		const [, report] = publish.mock.calls[0];
		expect(report.files).toEqual([{ path: "test/a.test.ts", state: "fail", errors: [expect.stringContaining("passou de 60 minutos")], tests: [] }]);
	});

	it("reports no tests right away", async () => {
		const RUNS = await fakeD1();
		const github = { listFiles: async () => ["src/a.ts"], getFileText: async () => undefined } as unknown as GitHubClient;
		const result = await tests.run({ github, repo: "octo/app", pr, env: { RUNS } as Env, installationId: 9 });
		expect(result).toMatchObject({ conclusion: "neutral", title: "Nenhum teste encontrado" });
		expect((await d1RunStore(RUNS).list())[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
	});

	it("publishes once, when the last shard finishes, with every shard's results", async () => {
		const { deps, publish } = await setup(2, async (s) => passing(s.files));
		await processShard(shard(["b.test.ts"], "0"), 1, deps);
		expect(publish).not.toHaveBeenCalled();
		await processShard(shard(["a.test.ts"], "1"), 1, deps);
		// Delivered again: counted once.
		await processShard(shard(["a.test.ts"], "1"), 1, deps);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls[0][1].files.map((f) => f.path)).toEqual(["a.test.ts", "b.test.ts"]);
	});

	it("splits a shard whose code is too big until it fits", async () => {
		const run = vi.fn(async (s: TestShard) => {
			if (s.files.includes("huge.test.ts") && s.files.length > 1) throw new TooLarge(MAX_CODE_BYTES + 1);
			return passing(s.files);
		});
		const { deps, queue, publish } = await setup(1, run);
		queue.push({ shard: shard(["a.test.ts", "b.test.ts", "c.test.ts", "huge.test.ts"]), attempts: 1 });
		await drain(queue, deps);
		expect(run.mock.calls.map(([s]) => s.shard)).toEqual(["0", "0.0", "0.1", "0.1.0", "0.1.1"]);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls[0][1].files.map((f) => f.path)).toEqual(["a.test.ts", "b.test.ts", "c.test.ts", "huge.test.ts"]);
	});

	it("reports a single file that is too big as failed", async () => {
		const { deps, publish } = await setup(1, async () => {
			throw new TooLarge(100 * 1024 * 1024);
		});
		await processShard(shard(["huge.test.ts"]), 1, deps);
		expect(publish.mock.calls[0][1].files).toEqual([
			{ path: "huge.test.ts", state: "fail", tests: [], errors: [expect.stringContaining("100 MB")] },
		]);
	});

	it("retries a shard that crashed in halves, and gives up on a single file", async () => {
		const run = vi.fn(async (s: TestShard) => passing(s.files));
		const { deps, queue, publish } = await setup(1, run);
		await processShard(shard(["a.test.ts", "b.test.ts"]), 2, deps);
		expect(run).not.toHaveBeenCalled();
		expect(queue.map((q) => q.shard.files)).toEqual([["a.test.ts"], ["b.test.ts"]]);
		await processShard(queue[0].shard, 1, deps);
		await processShard(queue[1].shard, 3, deps);
		expect(publish.mock.calls[0][1].files).toEqual([
			expect.objectContaining({ path: "a.test.ts", state: "pass" }),
			{ path: "b.test.ts", state: "fail", tests: [], errors: [expect.stringContaining("memória")] },
		]);
	});

	it("isolates a file that takes the Dynamic Worker down", async () => {
		const { deps, queue, publish } = await setup(1, async (s) => {
			if (s.files.includes("bad.test.ts")) throw new Crashed(new Error("Network connection lost."));
			return passing(s.files);
		});
		queue.push({ shard: shard(["a.test.ts", "bad.test.ts", "c.test.ts"]), attempts: 1 });
		await drain(queue, deps);
		expect(publish.mock.calls[0][1].files).toEqual([
			expect.objectContaining({ path: "a.test.ts", state: "pass" }),
			{ path: "bad.test.ts", state: "fail", tests: [], errors: [expect.stringContaining("Network connection lost.")] },
			expect.objectContaining({ path: "c.test.ts", state: "pass" }),
		]);
	});
});
