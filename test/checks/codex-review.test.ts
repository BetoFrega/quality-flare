import { describe, expect, it, vi } from "vitest";
import { codexReview } from "../../src/checks/codex-review/index.ts";
import { evaluate, isReviewing, parseSuggestion } from "../../src/checks/codex-review/evaluate.ts";
import type { CheckContext } from "../../src/checks/types.ts";
import type { ReviewActivity } from "../../src/github.ts";

const CODEX = "chatgpt-codex-connector";
const suggestion = (priority: string, title: string) =>
	`**<sub><sub>![${priority} Badge](https://img.shields.io/badge/${priority}-yellow?style=flat)</sub></sub>  ${title}**\n\nDetails.\n\nUseful? React with 👍 / 👎.`;

function activity(over: Partial<ReviewActivity> = {}): ReviewActivity {
	return { threads: [], reviewers: [], comments: [], eyesFrom: [], ...over };
}

function thread(resolved: boolean, author = CODEX, outdated = false) {
	return { resolved, outdated, author, body: suggestion("P1", "Add a timeout"), url: "https://github.com/o/r/pull/1#discussion_r1" };
}

/** Shape of the summary comment Codex keeps on the PR (copied from a real one, trimmed). */
const summary = (status: string, row = "✅ **Completed**") =>
	`<!-- codex-pull-request-review-summary -->\n<!-- codex-security-review:v1 {"headSha":"8c4864d","mergeGateEnabled":false,"status":"${status}"} -->\n## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ${row} | \`2c97cf8\` | Manual request |`;

describe("evaluate", () => {
	it("fails while a Codex thread is unresolved, listing it", () => {
		const r = evaluate(activity({ threads: [thread(false), thread(true), thread(false, "octocat")], reviewers: [`${CODEX}`] }));
		expect(r.conclusion).toBe("failure");
		expect(r.title).toBe("1 sugestão do Codex sem resolver");
		expect(r.summary).toContain("**P1** [Add a timeout](https://github.com/o/r/pull/1#discussion_r1)");
	});

	it("counts outdated threads until they are resolved", () => {
		const r = evaluate(activity({ threads: [thread(false, CODEX, true)] }));
		expect(r.conclusion).toBe("failure");
		expect(r.summary).toContain("código já mudou");
	});

	it("passes once every Codex thread is resolved", () => {
		const r = evaluate(activity({ threads: [thread(true), thread(true)], comments: [{ author: CODEX, body: summary("completed") }] }));
		expect(r).toMatchObject({ conclusion: "success", title: "Todas as sugestões do Codex foram resolvidas (2)" });
	});

	it("passes when Codex reviewed and found nothing", () => {
		const r = evaluate(activity({ comments: [{ author: CODEX, body: "Codex Review: Didn't find any major issues. Swish!" }] }));
		expect(r).toMatchObject({ conclusion: "success", title: "O Codex não encontrou problemas" });
	});

	it("stays pending while Codex is still reviewing", () => {
		expect(evaluate(activity({ eyesFrom: [CODEX] }))).toMatchObject({ conclusion: "pending", title: "O Codex está revisando a PR" });
	});

	it("is neutral before Codex shows up", () => {
		expect(evaluate(activity({ threads: [thread(false, "octocat")], reviewers: ["octocat"] })).conclusion).toBe("neutral");
	});
});

describe("isReviewing", () => {
	it("reads the status in the summary comment", () => {
		expect(isReviewing(activity({ comments: [{ author: CODEX, body: summary("in_progress") }] }))).toBe(true);
		expect(isReviewing(activity({ comments: [{ author: CODEX, body: summary("completed") }] }))).toBe(false);
		expect(isReviewing(activity({ comments: [{ author: CODEX, body: summary("completed", "⏳ **In progress**") }] }))).toBe(true);
	});

	it("reads the per-review state Codex nests in codex-review-state", () => {
		// Copied from macae-classificados #2156, trimmed.
		const state = (code: string, security: string) =>
			`<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"de0fac6","has_any_findings":null,"status":"${code}"},"security_review":{"commit_sha":"86d17e8","has_any_findings":false,"status":"${security}"}} -->\n<!-- codex-security-review:v1 {"headSha":"86d17e8","mergeGateEnabled":false,"status":"${security}"} -->\n## Codex Review Summary`;
		const reviewing = (body: string) => isReviewing(activity({ comments: [{ author: CODEX, body }] }));
		expect(reviewing(state("completed", "completed"))).toBe(false);
		expect(reviewing(state("running", "completed"))).toBe(true);
		expect(reviewing(state("completed", "running"))).toBe(true);
	});

	it("trusts codex-review-state over a codex-security-review left running", () => {
		// Copied from quality-flare #56: the security review completed, its own marker still said running.
		const body =
			'<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":"completed"}} -->\n<!-- codex-security-review:v1 {"blockingSeverityThreshold":"P0","headSha":"f22f81b","mergeGateEnabled":false,"pullRequestNumber":56,"repository":"BetoFrega/quality-flare","status":"running"} -->\n## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 🔒 **Security Review** | ✅ **Completed** | — | Draft marked ready |';
		expect(isReviewing(activity({ comments: [{ author: CODEX, body }] }))).toBe(false);
	});

	it("trusts the summary over a 👀 that was not removed yet", () => {
		expect(isReviewing(activity({ comments: [{ author: CODEX, body: summary("completed") }], eyesFrom: [CODEX] }))).toBe(false);
	});

	it("ignores summaries posted by someone else", () => {
		expect(isReviewing(activity({ comments: [{ author: "octocat", body: summary("in_progress") }] }))).toBe(false);
	});
});

describe("parseSuggestion", () => {
	it("extracts the priority badge and title", () => {
		expect(parseSuggestion(suggestion("P2", "Do not serialize exception messages"))).toEqual({
			priority: "P2",
			title: "Do not serialize exception messages",
		});
	});

	it("falls back to the first line", () => {
		expect(parseSuggestion("Plain comment\nmore")).toEqual({ priority: undefined, title: "Plain comment" });
	});
});

describe("codex review check", () => {
	it("reads the PR's review activity", async () => {
		const getReviewActivity = vi.fn(async () => activity({ threads: [thread(false)] }));
		const ctx = { github: { getReviewActivity }, repo: "o/r", pr: { number: 3 } } as unknown as CheckContext;
		expect(await codexReview.run(ctx)).toMatchObject({ conclusion: "failure" });
		expect(getReviewActivity).toHaveBeenCalledWith("o/r", 3);
	});

	it("re-runs on review events and PR comments", () => {
		for (const e of ["pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment"])
			expect(codexReview.events?.has(e)).toBe(true);
	});
});
