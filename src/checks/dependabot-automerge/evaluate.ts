import type { CheckResult } from "../types.ts";

export const DEPENDABOT_LOGIN = "dependabot[bot]";

/** Turns the answer to `enablePullRequestAutoMerge` into the check's result. */
export function evaluate(errors: string[]): CheckResult {
	if (!errors.length) {
		return {
			conclusion: "success",
			title: "Auto-merge enabled (squash)",
			summary: "The Dependabot PR will be squash-merged as soon as the required checks pass.",
		};
	}
	const message = errors.join("; ");
	// Auto-merge only exists while required checks are pending. Dependabot rebases its PRs whenever
	// the base branch moves, and the next `synchronize` brings the PR back here with checks pending.
	if (/clean status|unstable status/i.test(message)) {
		return {
			conclusion: "neutral",
			title: "Nothing to do: the PR can already be merged",
			summary:
				"GitHub only accepts auto-merge while required checks are pending. When the base branch changes, Dependabot rebases and the check tries again.",
		};
	}
	if (/auto.?merge is not allowed|not allowed for this repository/i.test(message)) {
		return failure(message, "Turn on **Settings → General → Pull Requests → Allow auto-merge** in the repository.");
	}
	if (/not accessible by integration/i.test(message)) {
		return failure(
			message,
			"The GitHub App needs the **Contents: Read and write** and **Pull requests: Read and write** permissions, accepted on the installation.",
		);
	}
	return failure(message);
}

function failure(message: string, fix?: string): CheckResult {
	return {
		conclusion: "failure",
		title: "Could not enable auto-merge",
		summary: [`GitHub responded: ${message}`, fix].filter(Boolean).join("\n\n"),
	};
}
