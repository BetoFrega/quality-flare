import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/checks/closes-issue/evaluate.ts";
import { skipResult } from "../../src/checks/closes-issue/skip.ts";

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
	const base = { author: "beto", draft: false, labels: [] as string[], base: "main", defaultBranch: "main" };

	it("evaluates a ready PR", () => {
		expect(skipResult(base)).toBeNull();
	});

	it("skips a draft", () => {
		expect(skipResult({ ...base, draft: true })?.conclusion).toBe("skipped");
	});

	it("evaluates a draft with the run-ci label", () => {
		expect(skipResult({ ...base, draft: true, labels: ["Run-CI"] })).toBeNull();
	});

	it("skips a PR into another branch", () => {
		expect(skipResult({ ...base, base: "release" })).toMatchObject({ conclusion: "skipped", title: "Skipped: targets `release`" });
	});

	it("skips Dependabot", () => {
		expect(skipResult({ ...base, author: "dependabot[bot]" })).toMatchObject({ conclusion: "skipped", title: "Skipped: Dependabot pull request" });
	});
});
