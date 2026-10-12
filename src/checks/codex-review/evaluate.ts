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
	return { priority, title: title || "Sugestão do Codex" };
}

/**
 * Whether a Codex review is running. The summary comment, when Codex posts one, is updated as each
 * review finishes; older setups only show 👀 on the PR while reviewing.
 */
export function isReviewing(activity: ReviewActivity): boolean {
	const summary = activity.comments.findLast((c) => isCodex(c.author) && c.body.includes(SUMMARY_MARKER));
	if (summary) {
		const status = summary.body.match(/<!-- codex-[\w-]+:v\d+ (\{.*?\}) -->/)?.[1];
		if (status) {
			try {
				if ((JSON.parse(status) as { status?: string }).status !== "completed") return true;
			} catch {
				// Unknown format: fall back to the table.
			}
		}
		return /\|\s*[^|\n]*\b(in progress|running|queued|pending)\b/i.test(summary.body);
	}
	return activity.eyesFrom.some(isCodex);
}

export function evaluate(activity: ReviewActivity): CheckResult {
	const findings = openFindings(activity);
	if (findings.length) {
		const list = findings.map(
			(f) => `- ${f.priority ? `**${f.priority}** ` : ""}[${f.title}](${f.url})${f.outdated ? " _(código já mudou)_" : ""}`,
		);
		return {
			conclusion: "failure",
			title: findings.length === 1 ? "1 sugestão do Codex sem resolver" : `${findings.length} sugestões do Codex sem resolver`,
			summary: [
				"Resolva cada conversa aberta pelo Codex (corrigindo ou respondendo por que não) e clique em **Resolve conversation**. O check reavalia sozinho.",
				list.join("\n"),
			].join("\n\n"),
		};
	}
	if (isReviewing(activity)) {
		return {
			conclusion: "failure",
			title: "O Codex está revisando a PR",
			summary: "Espere a review do Codex terminar. O check reavalia sozinho quando ela chegar.",
		};
	}
	const resolved = activity.threads.filter((t) => isCodex(t.author)).length;
	const reviewed = resolved > 0 || activity.reviewers.some(isCodex) || activity.comments.some((c) => isCodex(c.author));
	if (!reviewed) {
		return {
			conclusion: "neutral",
			title: "O Codex ainda não revisou esta PR",
			summary: "Nenhuma review do Codex por enquanto. Quando ela chegar, o check reavalia sozinho. Para pedir uma, comente `@codex review`.",
		};
	}
	return {
		conclusion: "success",
		title: resolved ? `Todas as sugestões do Codex foram resolvidas (${resolved})` : "O Codex não encontrou problemas",
		summary: resolved
			? "Cada conversa aberta pelo Codex foi resolvida."
			: "O Codex revisou a PR e não deixou sugestões.",
	};
}
