import { describe, expect, it } from "vitest";
import type { Check } from "../src/checks/types.ts";
import { planDelivery } from "../src/index.ts";

const fake = (name: string): Check => ({ id: name.toLowerCase(), name, run: async () => ({ conclusion: "success", title: "", summary: "" }) });
const checks = [fake("A"), fake("B")];
const pr = { number: 7, body: null, head: { sha: "abc" }, labels: [] };

describe("planDelivery", () => {
	it("runs every check on pull_request events", () => {
		expect(planDelivery("pull_request", { action: "synchronize", pull_request: pr }, checks)).toEqual({
			pullRequests: [pr],
			checks,
		});
	});

	it("skips checks that don't care about the action", () => {
		const codeOnly = { ...fake("C"), pullRequestActions: new Set(["synchronize"]) };
		expect(planDelivery("pull_request", { action: "labeled", pull_request: pr }, [checks[0], codeOnly])?.checks).toEqual([checks[0]]);
		expect(planDelivery("pull_request", { action: "synchronize", pull_request: pr }, [codeOnly])?.checks).toEqual([codeOnly]);
		expect(planDelivery("pull_request", { action: "labeled", pull_request: pr }, [codeOnly])).toBeNull();
	});

	it("re-runs only the requested check", () => {
		const plan = planDelivery(
			"check_run",
			{ action: "rerequested", check_run: { name: "B", pull_requests: [{ number: 7 }] } },
			checks,
		);
		expect(plan).toEqual({ pullRequests: [7], checks: [checks[1]] });
	});

	it("re-runs every check when the whole suite is re-requested", () => {
		const plan = planDelivery("check_suite", { action: "rerequested", check_suite: { pull_requests: [{ number: 7 }] } }, checks);
		expect(plan).toEqual({ pullRequests: [7], checks });
	});

	it("ignores check runs that belong to someone else", () => {
		expect(
			planDelivery("check_run", { action: "rerequested", check_run: { name: "C", pull_requests: [] } }, checks),
		).toBeNull();
	});
});
