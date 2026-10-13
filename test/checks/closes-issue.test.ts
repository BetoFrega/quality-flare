import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/checks/closes-issue/evaluate.ts";
import { evaluateRepair, parseRepairRefs } from "../../src/checks/closes-issue/repair.ts";
import { skipResult } from "../../src/checks/closes-issue/skip.ts";
import type { Issue } from "../../src/github.ts";

describe("evaluate", () => {
	it("passes when the no-issue label is present", () => {
		const r = evaluate({ body: null, labels: ["bug", "No-Issue"], linkedIssues: [] }, "no-issue");
		expect(r.conclusion).toBe("success");
	});

	it("passes when GitHub reports a linked issue", () => {
		const r = evaluate({ body: "", labels: [], linkedIssues: [{ number: 4 }] }, "no-issue");
		expect(r).toMatchObject({ conclusion: "success", title: "Closes #4" });
	});

	it("passes when the body has a closing keyword", () => {
		const r = evaluate({ body: "Fixes o/r#2", labels: [], linkedIssues: [] }, "no-issue");
		expect(r).toMatchObject({ conclusion: "success", title: "Closes o/r#2" });
	});

	it("dedupes refs found by both GitHub and the parser", () => {
		const r = evaluate({ body: "Closes #4", labels: [], linkedIssues: [{ number: 4 }] }, "no-issue");
		expect(r.title).toBe("Closes #4");
	});

	it("fails otherwise and explains how to fix it", () => {
		const r = evaluate({ body: "Refs #4", labels: ["bug"], linkedIssues: [] }, "no-issue");
		expect(r.conclusion).toBe("failure");
		expect(r.summary).toContain("`no-issue`");
	});
});

describe("skipResult", () => {
	const base = { author: "beto", draft: false, labels: [] as string[] };

	it("evaluates a ready PR", () => {
		expect(skipResult(base)).toBeNull();
	});

	it("skips a draft", () => {
		expect(skipResult({ ...base, draft: true })?.conclusion).toBe("skipped");
	});

	it("evaluates a draft with the run-ci label", () => {
		expect(skipResult({ ...base, draft: true, labels: ["Run-CI"] })).toBeNull();
	});

	it("skips Dependabot", () => {
		expect(skipResult({ ...base, author: "dependabot[bot]" })).toMatchObject({ conclusion: "skipped", title: "Skipped: Dependabot pull request" });
	});
});

describe("repair PRs", () => {
	const incident: Issue = {
		number: 7,
		state: "open",
		user: { login: "github-actions[bot]" },
		body: "Deploy failed.\n<!-- production-delivery-blocked -->",
	};

	it("reads one ref per line, ignoring refs inside other text", () => {
		expect(parseRepairRefs("Fix the deploy\n  Repairs delivery #7  \nsee Repairs delivery #8 too")).toEqual([7]);
		expect(parseRepairRefs("Repairs delivery #7\r\nRepairs delivery #8")).toEqual([7, 8]);
	});

	it("passes for an open automated incident", () => {
		expect(evaluateRepair([7], incident)).toMatchObject({ conclusion: "success", title: "Repairs delivery incident #7" });
	});

	it("fails without exactly one ref", () => {
		expect(evaluateRepair([], null).conclusion).toBe("failure");
		expect(evaluateRepair([7, 8], null).conclusion).toBe("failure");
	});

	it.each([
		["missing", null],
		["closed", { ...incident, state: "closed" as const }],
		["opened by a person", { ...incident, user: { login: "beto" } }],
		["without the marker", { ...incident, body: "Deploy failed." }],
		["a pull request", { ...incident, pull_request: {} }],
	])("fails when the incident is %s", (_, issue) => {
		expect(evaluateRepair([7], issue).conclusion).toBe("failure");
	});
});
