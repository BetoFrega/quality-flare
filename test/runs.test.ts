import { describe, expect, it } from "vitest";
import { tests } from "../src/checks/tests/index.ts";
import type { GitHubClient, PullRequest } from "../src/github.ts";
import { d1RunStore } from "../src/runs.ts";
import { fakeD1 } from "./fake-d1.ts";

const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";

// node:sqlite stands in for D1, so this only runs under Node.
describe.skipIf(inWorkers)("test run history", () => {
	it("records a run from start to finish, newest first", async () => {
		let clock = 1_000;
		const runs = d1RunStore(await fakeD1(), () => clock);
		const first = await runs.start({ repo: "octo/app", pr: 1, sha: "aaa", container: true });
		clock = 2_000;
		const second = await runs.start({ repo: "octo/app", pr: 2, sha: "bbb" });
		clock = 3_500;
		const report = { files: [{ path: "test/a.test.ts", state: "pass", tests: [{ name: "a", state: "pass" }] }] };
		await runs.finish(second, { conclusion: "success", title: "1 teste passaram", summary: "ok" }, report);

		expect(await runs.list()).toEqual([
			{ id: second, repo: "octo/app", pr: 2, sha: "bbb", status: "completed", conclusion: "success", title: "1 teste passaram", startedAt: 2_000, finishedAt: 3_500, container: false },
			{ id: first, repo: "octo/app", pr: 1, sha: "aaa", status: "running", conclusion: null, title: null, startedAt: 1_000, finishedAt: null, container: true },
		]);
		expect(await runs.get(second)).toMatchObject({ summary: "ok", report });
		expect(await runs.get(first)).toMatchObject({ summary: null, report: null, container: true });
		expect(await runs.get(999)).toBeNull();
	});

	it("filters by repository and state and sorts by date or duration", async () => {
		let clock = 0;
		const runs = d1RunStore(await fakeD1(), () => clock);
		const quick = await runs.start({ repo: "octo/app", pr: 1, sha: "a" });
		clock = 1_000;
		await runs.finish(quick, { conclusion: "success", title: "", summary: "" });
		const slow = await runs.start({ repo: "octo/lib", pr: 2, sha: "b" });
		clock = 61_000;
		await runs.finish(slow, { conclusion: "failure", title: "", summary: "" });
		const cut = await runs.start({ repo: "octo/app", pr: 3, sha: "c" });
		clock = 100 * 60_000;
		const live = await runs.start({ repo: "octo/app", pr: 4, sha: "d" });
		clock += 5_000;
		const ids = async (query: Parameters<typeof runs.list>[0]) => (await runs.list(query)).map((r) => r.id);

		expect(await ids({})).toEqual([live, cut, slow, quick]);
		expect(await ids({ sort: "oldest" })).toEqual([quick, slow, cut, live]);
		expect(await ids({ sort: "longest" })).toEqual([slow, live, quick, cut]);
		expect(await ids({ sort: "shortest" })).toEqual([quick, live, slow, cut]);
		expect(await ids({ repo: "octo/app" })).toEqual([live, cut, quick]);
		expect(await ids({ state: "failure" })).toEqual([slow]);
		expect(await ids({ state: "running" })).toEqual([live]);
		expect(await ids({ state: "stale" })).toEqual([cut]);
		expect(await ids({ repo: "octo/lib", state: "success" })).toEqual([]);
		expect(await runs.repos()).toEqual(["octo/app", "octo/lib"]);
	});

	it("is filled by the Tests check, even when the tests can't run", async () => {
		const RUNS = await fakeD1();
		const github = { listFiles: () => Promise.reject(new Error("403 Resource not accessible")) } as unknown as GitHubClient;
		const pr = { number: 7, body: null, head: { sha: "abc" }, labels: [] } as unknown as PullRequest;
		const result = await tests.run({ github, repo: "octo/app", pr, env: { RUNS } as Env, installationId: 1 });

		expect(result).toMatchObject({ conclusion: "failure", title: "Could not run the tests" });
		const [run] = await d1RunStore(RUNS).list();
		expect(run).toMatchObject({ repo: "octo/app", pr: 7, sha: "abc", status: "completed", conclusion: "failure" });
	});

	it("fails the check when D1, which coordinates the shards, is unavailable", async () => {
		const github = { listFiles: () => Promise.resolve(["a.test.ts"]) } as unknown as GitHubClient;
		const pr = { number: 7, body: null, head: { sha: "abc" }, labels: [] } as unknown as PullRequest;
		const broken = { prepare: () => { throw new Error("D1 down"); }, batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
		const result = await tests.run({ github, repo: "octo/app", pr, env: { RUNS: broken } as Env, installationId: 1 });
		expect(result).toMatchObject({ conclusion: "failure", summary: expect.stringContaining("D1") });
	});
});
