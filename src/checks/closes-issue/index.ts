import type { Check } from "../types.ts";
import { evaluate } from "./evaluate.ts";

/** Passes when the PR closes an issue, or carries the opt-out label. */
export const closesIssue: Check = {
	id: "closes-issue",
	name: "Closes an issue",
	async run({ github, repo, pr, env }) {
		const linkedIssues = await github.getLinkedIssues(repo, pr.number);
		return evaluate({ body: pr.body, labels: pr.labels.map((l) => l.name), linkedIssues }, env.NO_ISSUE_LABEL);
	},
};
