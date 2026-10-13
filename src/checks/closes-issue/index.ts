import type { Check } from "../types.ts";
import { evaluate } from "./evaluate.ts";
import { skipResult } from "./skip.ts";

/** Passes when the PR closes an issue, or carries the opt-out label. */
export const closesIssue: Check = {
	id: "closes-issue",
	name: "Closes an issue",
	async run({ github, repo, pr, env }) {
		const labels = pr.labels.map((l) => l.name);
		const skipped = skipResult({
			author: pr.user.login,
			draft: pr.draft,
			labels,
			base: pr.base.ref,
			defaultBranch: pr.base.repo.default_branch,
		});
		if (skipped) return skipped;

		const linkedIssues = await github.getLinkedIssues(repo, pr.number);
		return evaluate({ body: pr.body, labels, linkedIssues }, env.NO_ISSUE_LABEL);
	},
};
