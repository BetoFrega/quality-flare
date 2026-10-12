import type { Check } from "../types.ts";
import { DEPENDABOT_LOGIN, evaluate } from "./evaluate.ts";

/** Auto-merge can only be turned on while checks are pending, which happens when commits land. */
const COMMIT_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/** Enables squash auto-merge on Dependabot's PRs; neutral on everyone else's. */
export const dependabotAutomerge: Check = {
	id: "dependabot-automerge",
	name: "Dependabot auto-merge",
	pullRequestActions: COMMIT_ACTIONS,
	async run({ github, pr }) {
		if (pr.user.login !== DEPENDABOT_LOGIN) {
			return { conclusion: "neutral", title: "Não é uma PR do Dependabot", summary: "Este check só age em PRs abertas pelo Dependabot." };
		}
		return evaluate(await github.enableAutoMerge(pr.node_id, "SQUASH"));
	},
};
