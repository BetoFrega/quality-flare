import { describe, expect, it } from "vitest";
import { cost, d1MetricsStore, LOST_AFTER_MS, monthCost } from "../src/metrics.ts";
import { d1RunStore } from "../src/runs.ts";
import { fakeD1 } from "./fake-d1.ts";

const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const DAY = 86_400_000;
// 2026-10-13T00:00:00Z
const T = Date.UTC(2026, 9, 13);

// node:sqlite stands in for D1, so this only runs under Node.
describe.skipIf(inWorkers)("shard usage", () => {
	it("joins the consumer's record of an attempt with its Dynamic Worker's tail, in any order", async () => {
		let clock = T;
		const db = await fakeD1();
		const runId = await d1RunStore(db, () => clock).start({ repo: "octo/app", pr: 1, sha: "aaa" });
		const metrics = d1MetricsStore(db, () => clock);
		await metrics.start({ runId, shard: "0", attempt: 1, files: 5 });
		// The tail can land before the consumer records the end, or after it.
		await metrics.trace({ runId, shard: "0", attempt: 1, cpuMs: 1200.4, wallMs: 3000, outcome: "ok" });
		clock += 4_000;
		await metrics.finish({ runId, shard: "0", attempt: 1, outcome: "ran", codeBytes: 2_000_000, dynamicWorker: true });
		await metrics.start({ runId, shard: "1", attempt: 1, files: 5 });
		await metrics.finish({ runId, shard: "1", attempt: 1, outcome: "ran", codeBytes: 1_000, dynamicWorker: true });
		await metrics.trace({ runId, shard: "1", attempt: 1, cpuMs: 300, wallMs: 500, outcome: "ok" });

		expect(await metrics.attempts(runId)).toEqual([
			expect.objectContaining({ shard: "0", files: 5, outcome: "ran", codeBytes: 2_000_000, dynamicWorker: true, cpuMs: 1200, dwOutcome: "ok", startedAt: T, finishedAt: T + 4_000 }),
			expect.objectContaining({ shard: "1", outcome: "ran", dynamicWorker: true, cpuMs: 300 }),
		]);
		expect((await metrics.byRun([runId])).get(runId)).toEqual({ attempts: 2, retries: 0, crashes: 0, splits: 0, dynamicWorkers: 2, cpuMs: 1500, wallMs: 4_000 });
	});

	it("counts an attempt that never ended as a crash once it is old enough, and its redelivery as a retry", async () => {
		let clock = T;
		const db = await fakeD1();
		const runId = await d1RunStore(db, () => clock).start({ repo: "octo/app", pr: 1, sha: "aaa" });
		const metrics = d1MetricsStore(db, () => clock);
		await metrics.start({ runId, shard: "0", attempt: 1, files: 5 });
		expect((await metrics.byRun([runId])).get(runId)).toMatchObject({ crashes: 0 });
		clock += LOST_AFTER_MS + 1;
		await metrics.start({ runId, shard: "0", attempt: 2, files: 5 });
		await metrics.finish({ runId, shard: "0", attempt: 2, outcome: "split", dynamicWorker: false });
		// A Dynamic Worker that ran out of memory counts too.
		await metrics.trace({ runId, shard: "0.0", attempt: 1, cpuMs: 10, wallMs: 10, outcome: "exceededMemory" });
		expect((await metrics.byRun([runId, 999])).get(runId)).toMatchObject({ attempts: 3, retries: 1, crashes: 2, splits: 1, dynamicWorkers: 1 });
		expect(await metrics.byRun([])).toEqual(new Map());
	});

	it("sums usage per UTC day and month, for every repository or one", async () => {
		let clock = T - DAY;
		const db = await fakeD1();
		const runs = d1RunStore(db, () => clock);
		const metrics = d1MetricsStore(db, () => clock);
		const a = await runs.start({ repo: "octo/app", pr: 1, sha: "aaa" });
		await metrics.start({ runId: a, shard: "0", attempt: 1, files: 1 });
		await metrics.finish({ runId: a, shard: "0", attempt: 1, outcome: "ran", dynamicWorker: true });
		clock = T + 1_000;
		const b = await runs.start({ repo: "octo/lib", pr: 2, sha: "bbb" });
		for (const shard of ["0", "1"]) {
			await metrics.start({ runId: b, shard, attempt: 1, files: 1 });
			await metrics.finish({ runId: b, shard, attempt: 1, outcome: "ran", dynamicWorker: true });
		}

		expect(await metrics.usage("day", T - 30 * DAY)).toEqual([
			expect.objectContaining({ period: "2026-10-13", repo: null, runs: 1, attempts: 2, dynamicWorkers: 2 }),
			expect.objectContaining({ period: "2026-10-12", runs: 1, attempts: 1, dynamicWorkers: 1 }),
		]);
		expect(await metrics.usage("month", T - 30 * DAY)).toEqual([expect.objectContaining({ period: "2026-10", runs: 2, dynamicWorkers: 3 })]);
		expect(await metrics.usage("day", T - 30 * DAY, "octo/app")).toEqual([expect.objectContaining({ period: "2026-10-12", repo: "octo/app", runs: 1 })]);
		expect(await metrics.usage("day", T)).toHaveLength(1);
	});
	it("sums Container tests usage per run, and per UTC day or month", async () => {
		let clock = T - DAY;
		const db = await fakeD1();
		const runs = d1RunStore(db, () => clock);
		const metrics = d1MetricsStore(db, () => clock);
		const record = (runId: number, wallMs: number, cpuUs: number | null) =>
			db.prepare("UPDATE test_container_runs SET instance = 'standard-4', wall_ms = ?, cpu_us = ? WHERE run_id = ?").bind(wallMs, cpuUs, runId).run();
		const a = await runs.start({ repo: "octo/app", pr: 1, sha: "aaa", container: true });
		await record(a, 600_000, 1_000_000);
		clock = T;
		const b = await runs.start({ repo: "octo/other", pr: 1, sha: "bbb", container: true });
		// The container died before reporting its CPU.
		await record(b, 60_000, null);
		// Still running: its container hasn't stopped.
		const c = await runs.start({ repo: "octo/app", pr: 2, sha: "ccc", container: true });
		const notContainer = await runs.start({ repo: "octo/app", pr: 3, sha: "ddd" });

		const byRun = await metrics.containersByRun([a, b, c, notContainer]);
		expect([...byRun.keys()].sort()).toEqual([a, b].sort());
		expect(byRun.get(a)).toEqual({ runs: 1, wallMs: 600_000, cpuUs: 1_000_000, unmeasured: 0 });
		expect(byRun.get(b)).toEqual({ runs: 1, wallMs: 60_000, cpuUs: 0, unmeasured: 1 });
		expect(await metrics.containerUsage("day", T - 30 * DAY)).toEqual([
			{ period: "2026-10-13", runs: 1, wallMs: 60_000, cpuUs: 0, unmeasured: 1 },
			{ period: "2026-10-12", runs: 1, wallMs: 600_000, cpuUs: 1_000_000, unmeasured: 0 },
		]);
		expect(await metrics.containerUsage("month", T - 30 * DAY)).toEqual([{ period: "2026-10", runs: 2, wallMs: 660_000, cpuUs: 1_000_000, unmeasured: 1 }]);
		expect(await metrics.containerUsage("day", T - 30 * DAY, "octo/app")).toEqual([expect.objectContaining({ period: "2026-10-12", runs: 1 })]);
	});
});

describe("cost estimate", () => {
	const usage = { attempts: 100, retries: 0, crashes: 0, splits: 0, dynamicWorkers: 100, cpuMs: 1_000_000, wallMs: 0 };

	it("prices Dynamic Workers, CPU, requests and queue operations", () => {
		// 100 × 0.002 + 1M ms × 0.02/M + 200 requests × 0.3/M + 300 ops × 0.4/M
		expect(cost(usage)).toBeCloseTo(0.2 + 0.02 + 0.00006 + 0.00012, 8);
	});

	it("takes the monthly allowances off a month", () => {
		expect(monthCost(usage)).toBe(0);
		expect(monthCost({ ...usage, dynamicWorkers: 1_924, cpuMs: 31_000_000 })).toBeCloseTo(924 * 0.002 + 0.02, 8);
	});
});
