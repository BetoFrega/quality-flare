import { describe, expect, it, vi } from "vitest";
import { accountUsage, monthOverage } from "../src/account-usage.ts";

const NOW = Date.UTC(2026, 9, 13, 2);

describe("account usage", () => {
	it("reads Dynamic Workers and CPU per day from GraphQL Analytics, and sums the month", async () => {
		const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				data: {
					viewer: {
						accounts: [
							{
								dynamic: [
									{ dimensions: { date: "2026-10-12" }, uniq: { distinctDynamicWorkerCount: 530 } },
									{ dimensions: { date: "2026-10-13" }, uniq: { distinctDynamicWorkerCount: 1422 } },
								],
								workers: [
									{ dimensions: { date: "2026-10-13", scriptName: "quality-flare" }, sum: { cpuTimeUs: 14_355_794_112, requests: 7444, errors: 1465 } },
									{ dimensions: { date: "2026-10-13", scriptName: "other" }, sum: { cpuTimeUs: 1_000_000, requests: 9, errors: 0 } },
									{ dimensions: { date: "2026-09-30", scriptName: "quality-flare" }, sum: { cpuTimeUs: 2_000, requests: 1, errors: 0 } },
								],
							},
						],
					},
				},
				errors: null,
			}),
		);
		const usage = await accountUsage({ token: "t", account: "acc", script: "quality-flare", now: NOW, fetcher: fetcher as typeof fetch });

		const init = fetcher.mock.calls[0][1]!;
		expect(init.headers).toMatchObject({ Authorization: "Bearer t" });
		expect(JSON.parse(String(init.body)).variables).toEqual({ account: "acc", since: "2026-09-14", until: "2026-10-13" });
		expect(usage.days.map((d) => d.date)).toEqual(["2026-10-13", "2026-10-12", "2026-09-30"]);
		expect(usage.days[0]).toEqual({ date: "2026-10-13", dynamicWorkers: 1422, cpuMs: 14_355_794, requests: 7444, errors: 1465, accountCpuMs: 14_356_794 });
		// September stays out of October's totals.
		expect(usage.month).toEqual({ period: "2026-10", dynamicWorkers: 1952, cpuMs: 14_355_794, requests: 7444, errors: 1465, accountCpuMs: 14_356_794 });
		expect(monthOverage(usage.month)).toBeCloseTo(952 * 0.002, 8);
	});

	it("fails with GraphQL's errors", async () => {
		const fetcher = async () => Response.json({ data: null, errors: [{ message: "not authorized" }] });
		await expect(accountUsage({ token: "t", account: "acc", script: "quality-flare", now: NOW, fetcher })).rejects.toThrow("not authorized");
	});
});
