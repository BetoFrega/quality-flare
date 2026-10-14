import { ADMIN_PATH, handleAdmin } from "./admin/index.ts";
import { codexReview } from "./checks/codex-review/index.ts";
import { checks as allChecks } from "./checks/index.ts";
import { runTestShards, sweepOverdueRuns } from "./checks/tests/index.ts";
import type { TestShard } from "./checks/tests/jobs.ts";
import type { Check, CheckResult } from "./checks/types.ts";
import { verifySignature } from "./crypto.ts";
import { codexBlockComment, codexReviewBlock, explainWaiting, isRunCommand, type PullRequestComment, runsOnPush, WAITING_RESULT } from "./on-demand.ts";
import { GitHubClient, type PullRequest } from "./github.ts";
import { getRepoSettings, type RepoSettings } from "./settings.ts";

const PULL_REQUEST_ACTIONS = new Set([
	"opened",
	"reopened",
	"edited",
	"synchronize",
	"labeled",
	"unlabeled",
	"ready_for_review",
]);

/** Events about a PR's reviews whose payload carries the PR, for checks that list them in `events`. */
const REVIEW_EVENTS = new Set(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]);

interface WebhookPayload {
	action?: string;
	installation?: { id: number };
	repository?: { full_name: string };
	pull_request?: PullRequest;
	issue?: { number: number; pull_request?: unknown };
	comment?: PullRequestComment;
	check_run?: { name: string; pull_requests: { number: number }[] };
	check_suite?: { pull_requests: { number: number }[] };
}

/**
 * Reported instead of running a check that is off for an enabled repository,
 * so a check that branch protection requires doesn't block merges.
 */
export const DISABLED_RESULT: CheckResult = {
	conclusion: "neutral",
	title: "Desativado",
	summary: "Este check está desativado para este repositório no admin do quality-flare.",
};

export interface Plan {
	/** PR payloads, or numbers to fetch first. */
	pullRequests: (PullRequest | number)[];
	checks: Check[];
	/** A `/quality-flare run` comment asked for this delivery: on-demand checks run without waiting. */
	command?: { commentId: number };
	/** Someone pressed "Re-run": on-demand checks run without waiting. */
	rerun?: true;
}

export default {
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)) return handleAdmin(request, env, ctx.access);
		if (request.method === "GET") return new Response("quality-flare is running\n");
		if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405 });

		const body = await request.text();
		if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
			return new Response("Invalid signature\n", { status: 401 });
		}

		const payload = JSON.parse(body) as WebhookPayload;
		const plan = planDelivery(request.headers.get("X-GitHub-Event"), payload, allChecks);
		if (!plan || !payload.installation || !payload.repository) return new Response("Ignored\n", { status: 202 });

		const repo = payload.repository.full_name;
		const settings = await getRepoSettings(env.SETTINGS, repo);
		// Repositories start disabled: until someone enables one in the admin, its deliveries are ignored.
		if (!settings.enabled) return new Response("Repository not enabled\n", { status: 202 });
		// Checks such as Tests outlive GitHub's 10 s webhook timeout, so answer now and keep working.
		ctx.waitUntil(runPlan(plan, repo, payload.installation.id, settings, env));
		return new Response(`Running ${plan.checks.length} check(s) on ${plan.pullRequests.length} pull request(s)\n`);
	},
	// Shards of Tests runs, enqueued by the Tests check.
	async queue(batch, env, ctx) {
		await runTestShards(batch, env, ctx);
	},
	// Fails Tests runs past their deadline (see cloudflare.config.ts triggers).
	async scheduled(_controller, env) {
		await sweepOverdueRuns(env);
	},
} satisfies ExportedHandler<Env, TestShard>;

export async function runPlan(plan: Plan, repo: string, installationId: number, settings: RepoSettings, env: Env): Promise<void> {
	const github = await GitHubClient.forInstallation({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }, installationId);
	// With the on-demand setting off, a run command is just a comment.
	const checks = plan.command && !settings.onDemand ? plan.checks.filter((c) => !c.onDemand) : plan.checks;
	// What the run command got: 🚀 when it started a run, 👀 when every run it asked for was already going,
	// 😕 when the Codex review held it back.
	let commanded: "rocket" | "eyes" | "confused" | undefined;
	for (const target of plan.pullRequests) {
		// Re-run requests only carry the PR number; fetch it so labels and body are current.
		const pr = typeof target === "number" ? await github.getPullRequest(repo, target) : target;
		const waiting: string[] = [];
		const asksForTests = plan.command && checks.some((c) => c.onDemand && settings.enabledChecks.has(c.id));
		const codexBlock = asksForTests && settings.enabledChecks.has(codexReview.id) ? await codexBlocking(github, repo, pr.number) : undefined;
		if (codexBlock) {
			commanded = "confused";
			await github.commentOnPullRequest(repo, pr.number, codexBlockComment(codexBlock)).catch((error: unknown) => {
				console.error("quality-flare: could not explain the Codex review block", error);
			});
		}
		for (const check of checks) {
			// The Codex review comes first: a command while it blocks runs no tests.
			if (codexBlock && check.onDemand) continue;
			let result: CheckResult | null;
			if (!settings.enabledChecks.has(check.id)) result = DISABLED_RESULT;
			else if (check.onDemand && plan.command && (await runStatus(github, repo, pr.head.sha, check.name, env.GITHUB_APP_ID)) === "in_progress") {
				// A run already going on this commit (a push on a bot's PR, an earlier command) answers this command too.
				commanded ??= "eyes";
				continue;
			} else if (check.onDemand && !plan.command && !plan.rerun && !runsOnPush(settings.onDemand, pr)) {
				// A commit keeps the run it has: leaving draft or reopening on the same head must not queue a passed run again.
				result = (await runStatus(github, repo, pr.head.sha, check.name, env.GITHUB_APP_ID)) ? null : WAITING_RESULT;
				waiting.push(check.name);
			} else {
				if (check.onDemand && plan.command) commanded = "rocket";
				result = await check.run({ github, repo, pr, env, installationId });
			}
			if (result) await github.createCheckRun(repo, pr.head.sha, check.name, result);
		}
		// Agents watching a PR see a queued check as "pending", not its text; a comment reaches them.
		if (waiting.length && !pr.draft) {
			await explainWaiting(github, repo, pr.number, waiting).catch((error: unknown) => {
				console.error("quality-flare: could not explain the waiting checks", error);
			});
		}
	}
	if (plan.command && commanded) {
		await github.reactToComment(repo, plan.command.commentId, commanded).catch((error: unknown) => {
			console.error("quality-flare: could not react to the run command", error);
		});
	}
}

/** Why the Codex review blocks the PR, if it does; when GitHub can't say, it doesn't, so the command runs. */
function codexBlocking(github: GitHubClient, repo: string, pr: number): Promise<string | undefined> {
	return codexReviewBlock(github, repo, pr).catch((error: unknown) => {
		console.error("quality-flare: could not read the Codex review", error);
		return undefined;
	});
}

/** The status of the commit's latest run of the check; when GitHub can't say, there is none, so the check runs or waits. */
function runStatus(github: GitHubClient, repo: string, sha: string, name: string, appId: string): Promise<string | undefined> {
	return github.latestCheckRunStatus(repo, sha, name, appId).catch((error: unknown) => {
		console.error("quality-flare: could not list check runs", error);
		return undefined;
	});
}

/** Decides which checks to run on which PRs for a webhook delivery, or null to ignore it. */
export function planDelivery(event: string | null, payload: WebhookPayload, checks: Check[]): Plan | null {
	switch (event) {
		case "pull_request": {
			const action = payload.action ?? "";
			if (!payload.pull_request || !PULL_REQUEST_ACTIONS.has(action)) return null;
			const interested = checks.filter((c) => !c.pullRequestActions || c.pullRequestActions.has(action));
			return interested.length ? { pullRequests: [payload.pull_request], checks: interested } : null;
		}
		case "issue_comment": {
			// Comments on plain issues come through here too; the payload has no PR, so fetch it.
			if (!payload.issue?.pull_request) return null;
			const interested = checks.filter((c) => c.events?.has(event));
			const comment = payload.comment;
			if (payload.action === "created" && comment && isRunCommand(comment)) {
				const onDemand = checks.filter((c) => c.onDemand && !interested.includes(c));
				if (onDemand.length) {
					return { pullRequests: [payload.issue.number], checks: [...interested, ...onDemand], command: { commentId: comment.id } };
				}
			}
			return interested.length ? { pullRequests: [payload.issue.number], checks: interested } : null;
		}
		case "check_run": {
			// "Re-run" on one check run: run just that check, if it is ours.
			const check = checks.find((c) => c.name === payload.check_run?.name);
			if (payload.action !== "rerequested" || !check) return null;
			return { pullRequests: payload.check_run!.pull_requests.map((p) => p.number), checks: [check], rerun: true };
		}
		case "check_suite":
			if (payload.action !== "rerequested" || !payload.check_suite) return null;
			return { pullRequests: payload.check_suite.pull_requests.map((p) => p.number), checks, rerun: true };
		default: {
			if (!event || !REVIEW_EVENTS.has(event) || !payload.pull_request) return null;
			const interested = checks.filter((c) => c.events?.has(event));
			return interested.length ? { pullRequests: [payload.pull_request], checks: interested } : null;
		}
	}
}
export { TestBox } from "./checks/tests/container.ts";
export { RunsHub } from "./live.ts";
export { ShardTail } from "./shard-tail.ts";
