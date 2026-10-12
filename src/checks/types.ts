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
	/** The GitHub App installation the delivery came from, for work that continues outside the webhook. */
	installationId: number;
}

/** One CI check. Each check reports its own check run on the PR's head commit. */
export interface Check {
	/** Stable identifier, used to store per-repository settings. Never change it once released. */
	id: string;
	/** Check run name shown on the PR; also how "Re-run" requests are routed back to the check. */
	name: string;
	/** `pull_request` actions that run this check; all handled actions when omitted. Re-runs always run it. */
	pullRequestActions?: ReadonlySet<string>;
	/** The result to report, or null when the check reports its own check run later (Tests, via a queue). */
	run(ctx: CheckContext): Promise<CheckResult | null>;
}
