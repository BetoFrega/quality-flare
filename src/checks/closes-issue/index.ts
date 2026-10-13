import type { Check } from "../types.ts";
import { evaluate } from "./evaluate.ts";
import { evaluateRepair, parseRepairRefs, REPAIR_LABEL } from "./repair.ts";
import { hasLabel, skipResult } from "./skip.ts";

/** Passes when the PR closes an issue, or carries the opt-out label. */
export const closesIssue: Check = {
	id: "closes-issue",
	name: "Closes an issue",
	async run({ github, repo, pr, env }) {
		const labels = pr.labels.map((l) => l.name);
		const skipped = skipResult({ author: pr.user.login, draft: pr.draft, labels });
		if (skipped) return skipped;

		// A repair must not close its incident, so it is judged on its own terms and the opt-out label doesn't apply.
		if (hasLabel(labels, REPAIR_LABEL)) {
			const refs = parseRepairRefs(pr.body);
			const issue = refs.length === 1 ? await github.getIssue(repo, refs[0]) : null;
			return evaluateRepair(refs, issue);
		}

		const linkedIssues = await github.getLinkedIssues(repo, pr.number);
		return evaluate({ body: pr.body, labels, linkedIssues }, env.NO_ISSUE_LABEL);
	},
};
