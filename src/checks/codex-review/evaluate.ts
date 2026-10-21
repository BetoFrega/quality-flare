import type { ReviewActivity } from "../../github.ts";
import type { CheckResult } from "../types.ts";

/** GitHub login of the Codex reviewer (GraphQL reports bots without the "[bot]" suffix). */
export const CODEX_LOGIN = "chatgpt-codex-connector";

/** The comment where Codex keeps the status of its reviews up to date. */
const SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";

export interface Finding {
	url: string;
	/** "P0", "P1"… from the badge Codex puts on each suggestion. */
	priority?: string;
	title: string;
	outdated: boolean;
}

export function isCodex(login: string | undefined): boolean {
	return login?.replace(/\[bot\]$/, "") === CODEX_LOGIN;
}

/** Codex's suggestions (review threads it opened) that nobody resolved yet. */
export function openFindings(activity: ReviewActivity): Finding[] {
	return activity.threads
		.filter((t) => !t.resolved && isCodex(t.author))
		.map((t) => ({ url: t.url, outdated: t.outdated, ...parseSuggestion(t.body) }));
}

/** Codex bolds the badge and the title together: `**<sub><sub>![P1 Badge](…)</sub></sub>  Title**`. */
export function parseSuggestion(body: string): { priority?: string; title: string } {
	const priority = body.match(/!\[(P\d) Badge\]/)?.[1];
	const bold = body.match(/\*\*([\s\S]+?)\*\*/)?.[1] ?? body.split("\n")[0];
	const title = bold
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/<\/?sub>/g, "")
		.trim();
	return { priority, title: title || "Codex suggestion" };
}

const RUNNING = /^(in[ _-]?progress|running|queued|pending)$/i;

/**
 * Whether a Codex review is running. The summary comment, when Codex posts one, is updated as each
 * review finishes; older setups only show 👀 on the PR while reviewing.
 */
export function isReviewing(activity: ReviewActivity): boolean {
	const summary = activity.comments.findLast((c) => isCodex(c.author) && c.body.includes(SUMMARY_MARKER));
	if (summary) {
		if (markerStatuses(summary.body).some((s) => RUNNING.test(s))) return true;
		return /\|\s*[^|\n]*\b(in progress|running|queued|pending)\b/i.test(summary.body);
	}
	return activity.eyesFrom.some(isCodex);
}

/**
 * Statuses in the summary's hidden markers. `codex-security-review:v1` has its own `status`;
 * `codex-review-state:v1` nests one object per review: `{"code_review":{"status":"running"},…}`.
 * When both are there, only the second counts: Codex can leave the first at "running" after the
 * security review completed (quality-flare #56).
 */
function markerStatuses(body: string): string[] {
	const statuses: string[] = [];
	const markers = [...body.matchAll(/<!-- (codex-[\w-]+):v\d+ (\{.*?\}) -->/g)];
	const state = markers.filter(([, name]) => name === "codex-review-state");
	for (const [, , json] of state.length ? state : markers) {
		let state: unknown;
		try {
			state = JSON.parse(json);
		} catch {
			continue; // Unknown format: the table still says what is running.
		}
		for (const entry of [state, ...Object.values(state ?? {})]) {
			const status = (entry as { status?: unknown } | null)?.status;
			if (typeof status === "string") statuses.push(status);
		}
	}
	return statuses;
}

export function evaluate(activity: ReviewActivity): CheckResult {
	const findings = openFindings(activity);
	if (findings.length) {
		const list = findings.map(
			(f) => `- ${f.priority ? `**${f.priority}** ` : ""}[${f.title}](${f.url})${f.outdated ? " _(code already changed)_" : ""}`,
		);
		return {
			conclusion: "failure",
			title: findings.length === 1 ? "1 unresolved Codex suggestion" : `${findings.length} unresolved Codex suggestions`,
			summary: [
				"Resolve each conversation Codex opened (fix it or reply with why not) and click **Resolve conversation**. The check runs again on its own.",
				list.join("\n"),
			].join("\n\n"),
		};
	}
	if (isReviewing(activity)) {
		return {
			conclusion: "pending",
			title: "Codex is reviewing the PR",
			summary: "Wait for the Codex review to finish. The check runs again on its own when it arrives.",
		};
	}
	const resolved = activity.threads.filter((t) => isCodex(t.author)).length;
	const reviewed = resolved > 0 || activity.reviewers.some(isCodex) || activity.comments.some((c) => isCodex(c.author));
	if (!reviewed) {
		return {
			conclusion: "neutral",
			title: "Codex has not reviewed this PR yet",
			summary: "No Codex review yet. When it arrives, the check runs again on its own. To ask for one, comment `@codex review`.",
		};
	}
	return {
		conclusion: "success",
		title: resolved ? `All Codex suggestions were resolved (${resolved})` : "Codex found no problems",
		summary: resolved
			? "Every conversation Codex opened was resolved."
			: "Codex reviewed the PR and left no suggestions.",
	};
}
