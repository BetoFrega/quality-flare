import type { CheckResult } from "../types.ts";

export const DEPENDABOT_LOGIN = "dependabot[bot]";

/** Turns the answer to `enablePullRequestAutoMerge` into the check's result. */
export function evaluate(errors: string[]): CheckResult {
	if (!errors.length) {
		return {
			conclusion: "success",
			title: "Auto-merge habilitado (squash)",
			summary: "A PR do Dependabot vai ser mergeada com squash assim que os checks exigidos passarem.",
		};
	}
	const message = errors.join("; ");
	// Auto-merge only exists while required checks are pending. Dependabot rebases its PRs whenever
	// the base branch moves, and the next `synchronize` brings the PR back here with checks pending.
	if (/clean status|unstable status/i.test(message)) {
		return {
			conclusion: "neutral",
			title: "Nada a fazer: a PR já pode ser mergeada",
			summary:
				"O GitHub só aceita auto-merge enquanto há checks exigidos pendentes. Quando a branch base mudar, o Dependabot faz rebase e o check tenta de novo.",
		};
	}
	if (/auto.?merge is not allowed|not allowed for this repository/i.test(message)) {
		return failure(message, "Ative **Settings → General → Pull Requests → Allow auto-merge** no repositório.");
	}
	if (/not accessible by integration/i.test(message)) {
		return failure(
			message,
			"A GitHub App precisa das permissões **Contents: Read and write** e **Pull requests: Read and write**, aceitas na instalação.",
		);
	}
	return failure(message);
}

function failure(message: string, fix?: string): CheckResult {
	return {
		conclusion: "failure",
		title: "Não foi possível habilitar o auto-merge",
		summary: [`O GitHub respondeu: ${message}`, fix].filter(Boolean).join("\n\n"),
	};
}
