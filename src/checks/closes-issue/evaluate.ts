import type { CheckResult } from "../types.ts";
import { formatRef, parseClosingRefs, type IssueRef } from "./keywords.ts";

export interface PullRequestFacts {
	body: string | null;
	labels: string[];
	/** Issues GitHub itself reports this PR will close (keywords + manual links). */
	linkedIssues: IssueRef[];
}

export function evaluate(pr: PullRequestFacts, noIssueLabel: string): CheckResult {
	if (pr.labels.some((l) => l.toLowerCase() === noIssueLabel.toLowerCase())) {
		return {
			conclusion: "success",
			title: `Skipped: labeled \`${noIssueLabel}\``,
			summary: `This pull request has the \`${noIssueLabel}\` label, so it does not need to close an issue.`,
		};
	}

	const refs = dedupe([...pr.linkedIssues, ...parseClosingRefs(pr.body)]);
	if (refs.length > 0) {
		const list = refs.map(formatRef).join(", ");
		return {
			conclusion: "success",
			title: `Closes ${list}`,
			summary: `This pull request closes ${list}.`,
		};
	}

	return {
		conclusion: "failure",
		title: "No issue is closed by this pull request",
		summary: [
			"This pull request does not close any issue.",
			"",
			"To fix it, do one of the following:",
			"- Add a closing keyword to the description, such as `Closes #123`.",
			"- Link an issue in the **Development** section of the sidebar, then re-run this check.",
			`- Add the \`${noIssueLabel}\` label if this change does not need an issue.`,
		].join("\n"),
	};
}

function dedupe(refs: IssueRef[]): IssueRef[] {
	const seen = new Set<string>();
	return refs.filter((r) => {
		const key = formatRef(r).toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
