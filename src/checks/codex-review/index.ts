import type { Check } from "../types.ts";
import { evaluate } from "./evaluate.ts";

/** Fails while the PR has review threads from Codex that nobody resolved. */
export const codexReview: Check = {
	id: "codex-review",
	name: "Codex review",
	// Reviews, their comments and resolved conversations change the answer; so does the summary
	// comment Codex edits when a review finishes.
	events: new Set(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment"]),
	async run({ github, repo, pr }) {
		return evaluate(await github.getReviewActivity(repo, pr.number));
	},
};
