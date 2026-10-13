import type { CheckResult } from "./checks/types.ts";
import type { PullRequest } from "./github.ts";

/**
 * Tests on demand: with the repository's `onDemand` setting on, the checks marked `onDemand`
 * (Tests, Container tests) don't run on pushes. Each push leaves a queued check run that waits
 * for someone to comment `/quality-flare run`, which runs the PR's current head once. Agents
 * test locally while they work and ask for a run only when the PR is ready to merge.
 */
export const RUN_COMMAND = "/quality-flare run";

/** Who may start a run by commenting: people with access to the repository, not drive-by commenters. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface PullRequestComment {
	id: number;
	body: string | null;
	author_association: string;
}

/** Whether a comment asks for a run: its first line is the command, from someone trusted. */
export function isRunCommand(comment: PullRequestComment): boolean {
	const firstLine = (comment.body ?? "").trim().split("\n", 1)[0].trim().toLowerCase();
	return TRUSTED.has(comment.author_association) && (firstLine === RUN_COMMAND || firstLine.startsWith(`${RUN_COMMAND} `));
}

/** Whether a push runs the on-demand checks: with the setting off, and on PRs opened by bots such as Dependabot, which nobody would ask to run. */
export function runsOnPush(onDemand: boolean, pr: PullRequest): boolean {
	return !onDemand || pr.user.type === "Bot";
}

/** The queued check run a push leaves while it waits for a run command. */
export const WAITING_RESULT: CheckResult = {
	conclusion: "waiting",
	title: `Aguardando "${RUN_COMMAND}"`,
	summary: [
		`Este check só roda quando alguém com acesso ao repositório comenta \`${RUN_COMMAND}\` nesta PR. ` +
			"O comentário roda o commit atual uma vez; um push novo volta a esperar.",
		"",
		"**Agente:** rode os testes localmente o tempo todo, como sempre. Os testes remotos vêm por último: " +
			"monte tudo, abra a PR para review, corrija as reviews e deixe a PR pronta para o merge. Só então comente " +
			`\`${RUN_COMMAND}\`, quando achar que os testes vão passar. Depois que a suíte ficar verde, não faça mais push: ` +
			"cada push volta a esperar e cada execução custa dinheiro.",
	].join("\n"),
};
