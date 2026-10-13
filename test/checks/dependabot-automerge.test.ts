import { describe, expect, it, vi } from "vitest";
import { dependabotAutomerge } from "../../src/checks/dependabot-automerge/index.ts";
import { evaluate } from "../../src/checks/dependabot-automerge/evaluate.ts";
import type { CheckContext } from "../../src/checks/types.ts";

function context(login: string, errors: string[] = []) {
	const enableAutoMerge = vi.fn(async () => errors);
	const ctx = {
		github: { enableAutoMerge },
		repo: "octo/repo",
		pr: { number: 1, node_id: "PR_1", user: { login }, body: null, draft: false, head: { sha: "abc" }, labels: [] },
		env: {},
	} as unknown as CheckContext;
	return { ctx, enableAutoMerge };
}

describe("dependabot auto-merge", () => {
	it("enables squash auto-merge on Dependabot PRs", async () => {
		const { ctx, enableAutoMerge } = context("dependabot[bot]");
		expect(await dependabotAutomerge.run(ctx)).toMatchObject({ conclusion: "success" });
		expect(enableAutoMerge).toHaveBeenCalledWith("PR_1", "SQUASH");
	});

	it("leaves other authors' PRs alone", async () => {
		const { ctx, enableAutoMerge } = context("octocat");
		expect(await dependabotAutomerge.run(ctx)).toMatchObject({ conclusion: "neutral" });
		expect(enableAutoMerge).not.toHaveBeenCalled();
	});

	it("only runs when commits land", () => {
		expect(dependabotAutomerge.pullRequestActions?.has("synchronize")).toBe(true);
		expect(dependabotAutomerge.pullRequestActions?.has("labeled")).toBe(false);
	});
});

describe("evaluate", () => {
	it("is neutral when the PR is already mergeable", () => {
		expect(evaluate(["Pull request is in clean status"]).conclusion).toBe("neutral");
	});

	it("explains a repository without auto-merge", () => {
		const r = evaluate(["Auto merge is not allowed for this repository"]);
		expect(r.conclusion).toBe("failure");
		expect(r.summary).toContain("Allow auto-merge");
	});

	it("explains missing App permissions", () => {
		const r = evaluate(["Resource not accessible by integration"]);
		expect(r.conclusion).toBe("failure");
		expect(r.summary).toContain("Contents: Read and write");
	});

	it("fails with GitHub's message otherwise", () => {
		expect(evaluate(["boom"])).toMatchObject({ conclusion: "failure", summary: "O GitHub respondeu: boom" });
	});
});
