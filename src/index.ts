import { checks as allChecks } from "./checks/index.ts";
import type { Check } from "./checks/types.ts";
import { verifySignature } from "./crypto.ts";
import { GitHubClient, type PullRequest } from "./github.ts";

const PULL_REQUEST_ACTIONS = new Set([
	"opened",
	"reopened",
	"edited",
	"synchronize",
	"labeled",
	"unlabeled",
	"ready_for_review",
]);

interface WebhookPayload {
	action?: string;
	installation?: { id: number };
	repository?: { full_name: string };
	pull_request?: PullRequest;
	check_run?: { name: string; pull_requests: { number: number }[] };
	check_suite?: { pull_requests: { number: number }[] };
}

export interface Plan {
	/** PR payloads, or numbers to fetch first. */
	pullRequests: (PullRequest | number)[];
	checks: Check[];
}

export default {
	async fetch(request, env) {
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
		const github = await GitHubClient.forInstallation(
			{ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY },
			payload.installation.id,
		);
		for (const target of plan.pullRequests) {
			// Re-run requests only carry the PR number; fetch it so labels and body are current.
			const pr = typeof target === "number" ? await github.getPullRequest(repo, target) : target;
			for (const check of plan.checks) {
				const result = await check.run({ github, repo, pr, env });
				await github.createCheckRun(repo, pr.head.sha, check.name, result);
			}
		}
		return new Response(`Ran ${plan.checks.length} check(s) on ${plan.pullRequests.length} pull request(s)\n`);
	},
} satisfies ExportedHandler<Env>;

/** Decides which checks to run on which PRs for a webhook delivery, or null to ignore it. */
export function planDelivery(event: string | null, payload: WebhookPayload, checks: Check[]): Plan | null {
	switch (event) {
		case "pull_request":
			if (!payload.pull_request || !PULL_REQUEST_ACTIONS.has(payload.action ?? "")) return null;
			return { pullRequests: [payload.pull_request], checks };
		case "check_run": {
			// "Re-run" on one check run: run just that check, if it is ours.
			const check = checks.find((c) => c.name === payload.check_run?.name);
			if (payload.action !== "rerequested" || !check) return null;
			return { pullRequests: payload.check_run!.pull_requests.map((p) => p.number), checks: [check] };
		}
		case "check_suite":
			if (payload.action !== "rerequested" || !payload.check_suite) return null;
			return { pullRequests: payload.check_suite.pull_requests.map((p) => p.number), checks };
		default:
			return null;
	}
}
