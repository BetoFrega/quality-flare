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
		expect(plan).toEqual({ pullRequests: [7], checks: [checks[1]], rerun: true });
	});

	it("re-runs every check when the whole suite is re-requested", () => {
		const plan = planDelivery("check_suite", { action: "rerequested", check_suite: { pull_requests: [{ number: 7 }] } }, checks);
		expect(plan).toEqual({ pullRequests: [7], checks, rerun: true });
	});

	it("runs checks that listed a review event on the PR it carries", () => {
		const reviews = { ...fake("R"), events: new Set(["pull_request_review_thread", "issue_comment"]) };
		expect(planDelivery("pull_request_review_thread", { action: "resolved", pull_request: pr }, [...checks, reviews])).toEqual({
			pullRequests: [pr],
			checks: [reviews],
		});
		expect(planDelivery("pull_request_review", { action: "submitted", pull_request: pr }, [...checks, reviews])).toBeNull();
	});

	it("runs issue_comment checks only on PR comments, fetching the PR", () => {
		const reviews = { ...fake("R"), events: new Set(["issue_comment"]) };
		expect(planDelivery("issue_comment", { action: "edited", issue: { number: 7, pull_request: {} } }, [...checks, reviews])).toEqual({
			pullRequests: [7],
			checks: [reviews],
		});
		expect(planDelivery("issue_comment", { action: "created", issue: { number: 8 } }, [reviews])).toBeNull();
	});

	it("runs the on-demand checks on a run command from someone with access", () => {
		const tests = { ...fake("T"), onDemand: true };
		const reviews = { ...fake("R"), events: new Set(["issue_comment"]) };
		const issue = { number: 7, pull_request: {} };
		const comment = (body: string, author_association = "OWNER") => ({ id: 5, body, author_association });
		expect(planDelivery("issue_comment", { action: "created", issue, comment: comment("/quality-flare run") }, [...checks, tests, reviews])).toEqual({
			pullRequests: [7],
			checks: [reviews, tests],
			command: { commentId: 5 },
		});
		expect(planDelivery("issue_comment", { action: "created", issue, comment: comment("  /Quality-Flare run please\nthanks") }, [tests])?.command).toEqual({
			commentId: 5,
		});
		expect(planDelivery("issue_comment", { action: "created", issue, comment: comment("/quality-flare run", "NONE") }, [tests])).toBeNull();
		expect(planDelivery("issue_comment", { action: "created", issue, comment: comment("I ran /quality-flare run") }, [tests])).toBeNull();
		expect(planDelivery("issue_comment", { action: "created", issue, comment: comment("/quality-flare running") }, [tests])).toBeNull();
		expect(planDelivery("issue_comment", { action: "edited", issue, comment: comment("/quality-flare run") }, [tests])).toBeNull();
	});

	it("ignores check runs that belong to someone else", () => {
		expect(
			planDelivery("check_run", { action: "rerequested", check_run: { name: "C", pull_requests: [] } }, checks),
		).toBeNull();
	});
});
