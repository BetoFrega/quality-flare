import { evaluate as evaluateCodexReview } from "./checks/codex-review/evaluate.ts";
import type { CheckResult } from "./checks/types.ts";
import { type CheckRunState, type Comparison, type GitHubClient, type PullRequest, WAITING_CONCLUSION } from "./github.ts";

/**
 * Tests on demand: with the repository's `onDemand` setting on, the checks marked `onDemand`
 * (Tests, Container tests) don't run on pushes. Each push leaves an "action_required" check run that
 * waits for someone to comment `/quality-flare run`, which runs the PR's current head once. Agents
 * test locally while they work and ask for a run only when the PR is ready to merge. A push that only
 * merges the base into a head that passed keeps its runs (see inheritedRuns).
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

/** The check run a push leaves while it waits for a run command. */
export const WAITING_RESULT: CheckResult = {
	conclusion: "waiting",
	title: `Waiting for "${RUN_COMMAND}"`,
	summary: [
		`This check has not run yet. It runs only when someone with access to the repository comments \`${RUN_COMMAND}\` on this PR. ` +
			"It blocks the merge until then. The comment runs the current commit once. A new push makes it wait again.",
		"",
		"**Agent:** this check is yours to unblock. Run the tests locally all the time, as usual. The remote tests come last: " +
			"build everything, open the PR for review, fix the review comments and get the PR ready to merge. Only then comment " +
			`\`${RUN_COMMAND}\`, when you think the tests will pass. Once the suite is green, do not push again: ` +
			"each push makes it wait again, and each run costs money.",
	].join("\n"),
};

/** A passed run a merge commit takes over from the commit it merged into. */
export interface InheritedRun {
	name: string;
	result: CheckResult;
}

/** GitHub lists at most this many files per comparison; a longer list can't be checked whole. */
const COMPARE_FILES_LIMIT = 300;

/**
 * The passed runs a push keeps when its only new commit merges the base branch into a head that
 * passed, or undefined when the commit needs its own run. The merge must be clean: every file it
 * changes comes from the base exactly as there, and none of them was also changed by the PR, so
 * the PR's code is what passed. A conflict the base brings in another file (a renamed export the
 * PR uses) still slips through; the daily full run on the base catches it.
 * `checks` are the enabled on-demand checks and `runOnPush` every other check, whose runs stay
 * behind; the rest of the App's runs come along, such as the commands Container tests reports.
 */
export async function inheritedRuns(
	github: GitHubClient,
	repo: string,
	pr: PullRequest,
	checks: string[],
	runOnPush: string[],
	appId: string,
): Promise<InheritedRun[] | undefined> {
	const parents = await github.commitParents(repo, pr.head.sha);
	if (parents.length !== 2) return undefined;
	const [tested, merged] = parents;
	const runs = (await github.listCheckRuns(repo, tested, appId)).filter((r) => !runOnPush.includes(r.name));
	const passed = checks.every((name) => runs.some((r) => r.name === name && r.status === "completed" && r.conclusion === "success"));
	if (!passed || !runs.every((r) => r.status === "completed" && PASSING.has(r.conclusion ?? ""))) return undefined;
	// The merged commit must be on the base branch: merging another PR's branch brings untested code.
	const [onBase, fromBase, changed] = await Promise.all([
		github.compareCommits(repo, merged, pr.base.ref),
		github.compareCommits(repo, tested, merged),
		github.compareCommits(repo, tested, pr.head.sha),
	]);
	if (onBase.status !== "ahead" && onBase.status !== "identical") return undefined;
	if (!sameFiles(fromBase, changed)) return undefined;
	const summary =
		`Commit \`${short(pr.head.sha)}\` only merges \`${pr.base.ref}\` into commit \`${short(tested)}\` and touches none of the PR's files, ` +
		"so the result from there holds here. The daily run on the base catches anything the merge breaks outside those files.";
	return runs.map((r) => ({
		name: r.name,
		result: {
			conclusion: r.conclusion as "success" | "neutral" | "skipped",
			title: `Reused from ${short(tested)}${r.output.title ? `: ${r.output.title}` : ""}`,
			summary: `${summary}\n\n[Original run](${r.html_url})`,
		},
	}));
}

/** Whether the merge changed each file exactly as the base did, and only those: no file changed on both sides. */
function sameFiles(fromBase: Comparison, changed: Comparison): boolean {
	if (fromBase.files.length >= COMPARE_FILES_LIMIT || changed.files.length >= COMPARE_FILES_LIMIT) return false;
	if (fromBase.files.length !== changed.files.length) return false;
	const key = (f: Comparison["files"][number]) => `${f.status} ${f.previous_filename ?? ""} ${f.filename} ${f.sha}`;
	const base = new Set(fromBase.files.map(key));
	return changed.files.every((f) => base.has(key(f)));
}

/** Starts the one comment per PR that tells where its test checks stand; JSON after it records what the comment last said. */
const STATUS_MARKER = "<!-- quality-flare:on-demand";
const STATUS_PATTERN = /<!-- quality-flare:on-demand(?: (\{.*?\}))? -->/;

/** Where a PR's on-demand checks stand on one commit. */
export type StatusKind = "waiting" | "running" | "passed" | "failed" | "unavailable";

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
	/** The deploy left the test checks out (no Workers Paid): they report neutral without running. */
	unavailable?: boolean;
	previous?: StatusMark;
}

const PASSING = new Set(["success", "neutral", "skipped"]);

/** A run that waits for the command: completed as action_required, or queued as before that existed. */
const isWaiting = (run: CheckRunState | undefined) => run?.status !== "completed" || run.conclusion === WAITING_CONCLUSION;

function kindOf(runs: StatusInput["runs"]): StatusKind {
	if (runs.some((r) => r.run?.status === "in_progress")) return "running";
	if (runs.some((r) => isWaiting(r.run))) return "waiting";
	return runs.every((r) => PASSING.has(r.run?.conclusion ?? "")) ? "passed" : "failed";
}

function runLabel(run: CheckRunState | undefined): string {
	if (run?.status === "in_progress") return "🏃 running";
	if (isWaiting(run)) return "⏳ waiting";
	if (run?.conclusion === "success") return "✅ passed";
	return PASSING.has(run?.conclusion ?? "") ? `➖ ${run?.conclusion}` : `❌ ${run?.conclusion ?? "failed"}`;
}

const short = (sha: string) => sha.slice(0, 7);

/** The status comment for a PR's on-demand checks, and the mark it carries. */
export function renderStatus(input: StatusInput): { body: string; mark: StatusMark } {
	const kind = input.unavailable ? "unavailable" : kindOf(input.runs);
	const { previous } = input;
	const staleFrom =
		kind !== "waiting" || !previous ? undefined : previous.sha !== input.sha && previous.kind !== "waiting" ? previous.sha : previous.staleFrom;
	const mark: StatusMark = staleFrom ? { sha: input.sha, kind, staleFrom } : { sha: input.sha, kind };
	const commit = `\`${short(input.sha)}\``;
	const lines: string[] = [];
	if (kind === "waiting") {
		lines.push(input.codexBlock ? `### ⏸️ Tests: waiting for the Codex review (${commit})` : `### ⏳ Tests: waiting for \`${RUN_COMMAND}\` (${commit})`, "");
		if (staleFrom) {
			lines.push(
				`A push brought commit ${commit}. The run on commit \`${short(staleFrom)}\` does not count for it. The tests need another \`${RUN_COMMAND}\`.`,
				"",
			);
		}
		if (input.codexBlock) {
			if (input.ignoredCommand) lines.push(`The last \`${RUN_COMMAND}\` did not run anything.`, "");
			lines.push(
				`The **Codex review** still blocks this PR (${input.codexBlock}). Wait for the Codex review to finish and resolve its suggestions. ` +
					`Only then comment \`${RUN_COMMAND}\`. This comment will say when the tests can run.`,
			);
		} else {
			lines.push(
				"The checks below do not run on their own. Run the tests locally while you work. When the PR is ready to merge " +
					`(review comments fixed, nothing more to push), comment \`${RUN_COMMAND}\` as the first line of a comment. ` +
					"That tests the current commit once. Each new push waits for another comment, so do not push again " +
					"after the suite is green.",
			);
		}
	} else if (kind === "running") {
		lines.push(
			`### 🏃 Tests: running on commit ${commit}`,
			"",
			"Wait for the result without pushing. A new push makes this run out of date and waits for another " +
				`\`${RUN_COMMAND}\`.`,
		);
	} else if (kind === "unavailable") {
		lines.push(
			`### ➖ Tests: unavailable (${commit})`,
			"",
			"This quality-flare runs on a Cloudflare account without Workers Paid, which the test checks need. They do not run " +
				`and show as neutral. Run the tests locally. \`${RUN_COMMAND}\` changes nothing here.`,
		);
	} else if (kind === "passed") {
		lines.push(
			`### ✅ Tests: passed on commit ${commit}`,
			"",
			`Do not push again. Each push waits for another \`${RUN_COMMAND}\`, and each run costs money.`,
		);
	} else {
		lines.push(
			`### ❌ Tests: failed on commit ${commit}`,
			"",
			"Open the failed checks, fix them, run the tests locally and push. Then comment " +
				`\`${RUN_COMMAND}\` again to test the new commit.`,
		);
	}
	lines.push("", "| Check | Status |", "| --- | --- |", ...input.runs.map((r) => `| ${r.name} | ${runLabel(r.run)} |`));
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
	/** The test checks are unavailable (see StatusInput). */
	unavailable?: boolean;
	/** Create the comment when the PR has none; otherwise only an existing comment is updated. */
	create: boolean;
}

/**
 * Keeps one comment per PR saying where its on-demand checks stand on the head commit: waiting
 * (for the command or for the Codex review), running, passed or failed. Agents watching a PR see
 * a check's title, not its text, so they read this comment, and edits replace it instead of
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
		unavailable: update.unavailable,
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
