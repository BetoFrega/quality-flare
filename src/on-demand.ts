import { evaluate as evaluateCodexReview } from "./checks/codex-review/evaluate.ts";
import type { CheckResult } from "./checks/types.ts";
import type { CheckRunState, GitHubClient, PullRequest } from "./github.ts";

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

/** Starts the one comment per PR that tells where its test checks stand; JSON after it records what the comment last said. */
const STATUS_MARKER = "<!-- quality-flare:on-demand";
const STATUS_PATTERN = /<!-- quality-flare:on-demand(?: (\{.*?\}))? -->/;

/** Where a PR's on-demand checks stand on one commit. */
export type StatusKind = "waiting" | "running" | "passed" | "failed";

/** What the status comment says, kept in its marker so the next update knows what came before. */
export interface StatusMark {
	sha: string;
	kind: StatusKind;
	/** A commit whose run a later push left behind, shown until the next run starts. */
	staleFrom?: string;
}

export interface StatusInput {
	sha: string;
	/** The App's latest run of each enabled on-demand check on the commit. */
	runs: { name: string; run?: CheckRunState }[];
	/** Why the Codex review holds the PR back, when it does. */
	codexBlock?: string;
	/** A run command came while the Codex review held the PR back. */
	ignoredCommand?: boolean;
	previous?: StatusMark;
}

const PASSING = new Set(["success", "neutral", "skipped"]);

function kindOf(runs: StatusInput["runs"]): StatusKind {
	if (runs.some((r) => r.run?.status === "in_progress")) return "running";
	if (!runs.every((r) => r.run?.status === "completed")) return "waiting";
	return runs.every((r) => PASSING.has(r.run?.conclusion ?? "")) ? "passed" : "failed";
}

function runLabel(run: CheckRunState | undefined): string {
	if (run?.status === "in_progress") return "🏃 rodando";
	if (run?.status !== "completed") return "⏳ esperando";
	if (run.conclusion === "success") return "✅ passou";
	return PASSING.has(run.conclusion ?? "") ? `➖ ${run.conclusion}` : `❌ ${run.conclusion ?? "falhou"}`;
}

const short = (sha: string) => sha.slice(0, 7);

/** The status comment for a PR's on-demand checks, and the mark it carries. */
export function renderStatus(input: StatusInput): { body: string; mark: StatusMark } {
	const kind = kindOf(input.runs);
	const { previous } = input;
	const staleFrom =
		kind !== "waiting" || !previous ? undefined : previous.sha !== input.sha && previous.kind !== "waiting" ? previous.sha : previous.staleFrom;
	const mark: StatusMark = staleFrom ? { sha: input.sha, kind, staleFrom } : { sha: input.sha, kind };
	const commit = `\`${short(input.sha)}\``;
	const lines: string[] = [];
	if (kind === "waiting") {
		lines.push(input.codexBlock ? `### ⏸️ Testes: esperando o Codex review (${commit})` : `### ⏳ Testes: esperando \`${RUN_COMMAND}\` (${commit})`, "");
		if (staleFrom) {
			lines.push(
				`Um push trouxe o commit ${commit}: a execução no commit \`${short(staleFrom)}\` não vale para ele. Os testes precisam de outro \`${RUN_COMMAND}\`.`,
				"",
			);
		}
		if (input.codexBlock) {
			if (input.ignoredCommand) lines.push(`O último \`${RUN_COMMAND}\` não rodou nada.`, "");
			lines.push(
				`O **Codex review** ainda bloqueia esta PR (${input.codexBlock}). Espere a review do Codex terminar e resolva as sugestões dela; ` +
					`só então comente \`${RUN_COMMAND}\`. Este comentário avisa quando os testes puderem rodar.`,
			);
		} else {
			lines.push(
				"Os checks abaixo não rodam sozinhos. Rode os testes localmente enquanto trabalha. Quando a PR estiver pronta para o merge " +
					`(reviews corrigidas, nada mais a enviar), comente \`${RUN_COMMAND}\` como primeira linha de um comentário. ` +
					"Isso testa o commit atual uma vez; cada push novo volta a esperar outro comentário, então não faça mais push " +
					"depois que a suíte ficar verde.",
			);
		}
	} else if (kind === "running") {
		lines.push(
			`### 🏃 Testes: rodando no commit ${commit}`,
			"",
			"Espere o resultado sem fazer push: um push novo deixa esta execução desatualizada e volta a esperar outro " +
				`\`${RUN_COMMAND}\`.`,
		);
	} else if (kind === "passed") {
		lines.push(
			`### ✅ Testes: passaram no commit ${commit}`,
			"",
			`Não faça mais push: cada push volta a esperar outro \`${RUN_COMMAND}\` e cada execução custa dinheiro.`,
		);
	} else {
		lines.push(
			`### ❌ Testes: falharam no commit ${commit}`,
			"",
			"Abra os checks com falha, corrija, rode os testes localmente e faça push. Depois comente " +
				`\`${RUN_COMMAND}\` de novo para testar o commit novo.`,
		);
	}
	lines.push("", "| Check | Estado |", "| --- | --- |", ...input.runs.map((r) => `| ${r.name} | ${runLabel(r.run)} |`));
	return { body: [`${STATUS_MARKER} ${JSON.stringify(mark)} -->`, ...lines].join("\n"), mark };
}

/** The mark of a status comment, if it carries one (comments from before the mark existed don't). */
export function parseStatusMark(body: string): StatusMark | undefined {
	const json = body.match(STATUS_PATTERN)?.[1];
	if (!json) return undefined;
	try {
		return JSON.parse(json) as StatusMark;
	} catch {
		return undefined;
	}
}

export interface StatusUpdate {
	/** The enabled on-demand checks to report. */
	checks: string[];
	appId: string;
	/** Why the Codex review holds the PR back, or undefined when it doesn't; absent when the repository doesn't run it. */
	codexBlock?: () => Promise<string | undefined>;
	ignoredCommand?: boolean;
	/** Create the comment when the PR has none; otherwise only an existing comment is updated. */
	create: boolean;
}

/**
 * Keeps one comment per PR saying where its on-demand checks stand on the head commit: waiting
 * (for the command or for the Codex review), running, passed or failed. Agents watching a PR see
 * a queued check only as "pending", so they read this comment, and edits replace it instead of
 * piling up new ones. It is rewritten from GitHub's state on each event that can change it.
 */
export async function updateStatus(github: GitHubClient, repo: string, pr: PullRequest, update: StatusUpdate): Promise<void> {
	const existing = (await github.listPullRequestComments(repo, pr.number)).find((c) => c.body?.includes(STATUS_MARKER));
	if (!existing && !update.create) return;
	const runs = await Promise.all(
		update.checks.map(async (name) => ({ name, run: await github.latestCheckRun(repo, pr.head.sha, name, update.appId) })),
	);
	// The Codex review matters only while the tests wait: a run that started or finished stands.
	const codexBlock = kindOf(runs) === "waiting" ? await update.codexBlock?.() : undefined;
	const { body } = renderStatus({
		sha: pr.head.sha,
		runs,
		codexBlock,
		ignoredCommand: update.ignoredCommand,
		previous: existing?.body ? parseStatusMark(existing.body) : undefined,
	});
	if (!existing) await github.commentOnPullRequest(repo, pr.number, body);
	else if (existing.body !== body) await github.editComment(repo, existing.id, body);
}

/**
 * Why the Codex review still holds the PR back, or undefined when it doesn't: open Codex
 * suggestions or a review still running. Tests run after the review settles, since fixing its
 * suggestions changes the code they would test.
 */
export async function codexReviewBlock(github: GitHubClient, repo: string, pr: number): Promise<string | undefined> {
	const result = evaluateCodexReview(await github.getReviewActivity(repo, pr));
	return result.conclusion === "failure" || result.conclusion === "pending" ? result.title : undefined;
}
