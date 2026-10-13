import type { CheckResult } from "../types.ts";

/** Dependabot's PRs bump dependencies and never have an issue to close. */
export const DEPENDABOT_LOGIN = "dependabot[bot]";
/** Makes the check evaluate a draft PR, which it otherwise skips. */
export const RUN_CI_LABEL = "run-ci";

export interface SkipFacts {
	author: string;
	draft: boolean;
	labels: string[];
	/** The branch the PR merges into, and the repository's default branch. */
	base: string;
	defaultBranch: string;
}

/**
 * The result for a PR this check does not apply to, or null to evaluate it.
 * Skipping reports a conclusion rather than nothing, so the check can be required
 * without leaving drafts stuck on a pending check.
 */
export function skipResult(pr: SkipFacts): CheckResult | null {
	// GitHub only closes issues when a PR merges into the default branch.
	if (pr.base !== pr.defaultBranch) {
		return {
			conclusion: "skipped",
			title: `Skipped: targets \`${pr.base}\``,
			summary: `This check only runs on pull requests into \`${pr.defaultBranch}\`.`,
		};
	}
	if (pr.draft && !hasLabel(pr.labels, RUN_CI_LABEL)) {
		return {
			conclusion: "skipped",
			title: "Skipped: draft pull request",
			summary: `This check runs when the pull request is ready for review, or on a draft with the \`${RUN_CI_LABEL}\` label.`,
		};
	}
	if (pr.author === DEPENDABOT_LOGIN) {
		return {
			conclusion: "skipped",
			title: "Skipped: Dependabot pull request",
			summary: "Dependabot pull requests do not need to close an issue.",
		};
	}
	return null;
}

export function hasLabel(labels: string[], name: string): boolean {
	return labels.some((l) => l.toLowerCase() === name.toLowerCase());
}
