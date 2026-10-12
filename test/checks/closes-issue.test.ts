import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/checks/closes-issue/evaluate.ts";

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
