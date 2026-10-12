import type { GitHubClient, PullRequest } from "../github.ts";

export interface CheckResult {
	conclusion: "success" | "failure" | "neutral";
	title: string;
	summary: string;
}

export interface CheckContext {
	github: GitHubClient;
	/** "owner/repo" */
	repo: string;
	pr: PullRequest;
	env: Env;
}

/** One CI check. Each check reports its own check run on the PR's head commit. */
export interface Check {
	/** Check run name shown on the PR; also how "Re-run" requests are routed back to the check. */
	name: string;
	run(ctx: CheckContext): Promise<CheckResult>;
}
