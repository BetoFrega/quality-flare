import type { Issue } from "../../github.ts";
import type { CheckResult } from "../types.ts";

/**
 * Marks a PR that repairs a failed production delivery. It must reference the open
 * delivery incident without closing it: the deploy closes it once production is verified.
 */
export const REPAIR_LABEL = "repairs-main";
/** Who opens delivery incidents, and the marker their body carries. */
export const INCIDENT_AUTHOR = "github-actions[bot]";
export const INCIDENT_MARKER = "<!-- production-delivery-blocked -->";

const REPAIR_LINE = /^[ \t]*Repairs delivery[ \t]+#(\d+)[ \t\r]*$/gm;

/** Issue numbers from `Repairs delivery #<n>` lines, one per line, in order. Bodies edited on github.com use CRLF. */
export function parseRepairRefs(body: string | null | undefined): number[] {
	return [...(body ?? "").matchAll(REPAIR_LINE)].map((m) => Number(m[1]));
}

/** Judges a repair PR from its `Repairs delivery` refs and, when there is exactly one, the issue it names. */
export function evaluateRepair(refs: number[], issue: Issue | null): CheckResult {
	if (refs.length !== 1) {
		return {
			conclusion: "failure",
			title: "Repair must reference exactly one delivery incident",
			summary: [
				`This pull request has the \`${REPAIR_LABEL}\` label, so instead of a closing keyword its description needs exactly one line like:`,
				"",
				"    Repairs delivery #123",
				"",
				"That reference keeps the incident open until the deploy verifies production.",
			].join("\n"),
		};
	}
	const [number] = refs;
	const valid =
		issue !== null &&
		!issue.pull_request &&
		issue.state === "open" &&
		issue.user?.login === INCIDENT_AUTHOR &&
		(issue.body ?? "").includes(INCIDENT_MARKER);
	if (!valid) {
		return {
			conclusion: "failure",
			title: `#${number} is not an open delivery incident`,
			summary: `\`Repairs delivery #${number}\` must point to the open, automated production delivery incident.`,
		};
	}
	return {
		conclusion: "success",
		title: `Repairs delivery incident #${number}`,
		summary: `This pull request repairs delivery incident #${number}, which stays open until the deploy verifies production.`,
	};
}
