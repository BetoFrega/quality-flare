import type { GitHubClient, PullRequest } from "../github.ts";

/** How a completed check run ended. */
export type Conclusion = "success" | "failure" | "neutral" | "cancelled";

export interface CheckResult {
	/**
	 * "pending" leaves the check run in progress, for a result that waits on something outside the PR.
	 * "skipped" means the check does not apply to this PR; branch protection counts it as passing.
	 * "waiting" leaves the check run queued until someone asks for a run (see on-demand.ts).
	 */
	conclusion: Conclusion | "skipped" | "pending" | "waiting";
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
	/**
	 * Other webhook events that run this check on the PR they concern, such as `pull_request_review`.
	 * Only the events listed in `planDelivery` are supported.
	 */
	events?: ReadonlySet<string>;
	/**
	 * Costly checks that, with the repository's on-demand setting on, wait for a
	 * `/quality-flare run` comment instead of running on every push.
	 */
	onDemand?: boolean;
	/** The result to report, or null when the check reports its own check run later (Tests, via a queue). */
	run(ctx: CheckContext): Promise<CheckResult | null>;
}
