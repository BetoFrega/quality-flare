import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { runPlan } from "../src/index.ts";
import { codexReview } from "../src/checks/codex-review/index.ts";
import type { Check } from "../src/checks/types.ts";
import { setChecksEnabled, setRepoEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
	GITHUB_APP_ID: "1",
	GITHUB_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
	GITHUB_WEBHOOK_SECRET: "s3cret",
	NO_ISSUE_LABEL: "no-issue",
	ACCESS_AUD: "aud",
} as Env;

const pr = { number: 7, user: { login: "beto" }, draft: false, body: "Some change", head: { sha: "abc123" }, base: { ref: "main", repo: { default_branch: "main" } }, labels: [] as { name: string }[] };

function delivery(event: string, payload: object, secret = env.GITHUB_WEBHOOK_SECRET) {
	const body = JSON.stringify({ installation: { id: 99 }, repository: { full_name: "octo/repo" }, ...payload });
	return new Request("https://worker.example/", {
		method: "POST",
		body,
		headers: {
			"X-GitHub-Event": event,
			"X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		},
	});
}

/** Fakes the GitHub API and records the check runs created. */
function mockGitHub({
	linked = [] as { number: number; repository: { nameWithOwner: string } }[],
	fetchedPr = pr,
	existingRuns = {} as Record<string, string>,
	existingComments = [] as { id?: number; body: string }[],
	review = undefined as object | undefined,
	merge = undefined as MergeFake | undefined,
} = {}) {
	const checkRuns: Record<string, unknown>[] = [];
	const reactions: Record<string, unknown>[] = [];
	const comments: { body: string }[] = [];
	const edits: { id: string; body: string }[] = [];
	const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname;
		if (path === "/app/installations/99/access_tokens") return Response.json({ token: "inst-token" });
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer inst-token");
		if (path === "/graphql" && review) return Response.json({ data: { repository: { pullRequest: review } } });
		if (path === "/graphql")
			return Response.json({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: linked } } } } });
		if (path === "/repos/octo/repo/pulls/7") return Response.json(fetchedPr);
		if (path === "/repos/octo/repo/issues/7/comments") {
			if (init.method === "GET") return Response.json(existingComments);
			comments.push(JSON.parse(init.body as string));
			return Response.json({ id: 2 }, { status: 201 });
		}
		const edit = path.match(/^\/repos\/octo\/repo\/issues\/comments\/(\d+)$/);
		if (edit && init.method === "PATCH") {
			edits.push({ id: edit[1], ...JSON.parse(init.body as string) });
			return Response.json({ id: Number(edit[1]) });
		}
		if (path === "/repos/octo/repo/issues/comments/5/reactions") {
			reactions.push(JSON.parse(init.body as string));
			return Response.json({ id: 1 }, { status: 201 });
		}
		const parents = path.match(/^\/repos\/octo\/repo\/git\/commits\/(\w+)$/);
		if (parents) return Response.json({ parents: (merge?.parents[parents[1]] ?? ["older1"]).map((sha) => ({ sha })) });
		const compare = path.match(/^\/repos\/octo\/repo\/compare\/(.+)$/);
		if (compare && merge?.compare[compare[1]]) return Response.json(merge.compare[compare[1]]);
		const commit = path.match(/^\/repos\/octo\/repo\/commits\/(\w+)\/check-runs$/);
		if (commit) {
			const query = new URL(url).searchParams;
			expect(query.get("app_id")).toBe(env.GITHUB_APP_ID);
			if (!query.has("check_name")) return Response.json({ check_runs: merge?.runs[commit[1]] ?? [] });
			// The latest run is the newest one created here, else the one the commit had ("status:conclusion"; only abc123 has any).
			const name = query.get("check_name") ?? "";
			const created = checkRuns.findLast((r) => r.name === name && r.head_sha === commit[1]) as { status: string; conclusion?: string } | undefined;
			const existing = commit[1] === "abc123" ? (existingRuns[name] ?? "") : "";
			const [status, conclusion] = created ? [created.status, created.conclusion] : existing.split(":");
			return Response.json({ total_count: status ? 1 : 0, check_runs: status ? [{ status, conclusion: conclusion ?? null }] : [] });
		}
		if (path === "/repos/octo/repo/check-runs") {
			checkRuns.push(JSON.parse(init.body as string));
			return Response.json({ id: 1 }, { status: 201 });
		}
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { checkRuns, reactions, comments, edits, fetchMock };
}

/** A merge commit's parents, the App's runs on commits, and what comparing two commits ("base...head") returns. */
interface MergeFake {
	parents: Record<string, string[]>;
	runs: Record<string, { name: string; status: string; conclusion: string | null; html_url: string; output: { title: string } }[]>;
	compare: Record<string, { status: string; files?: { filename: string; status: string; sha: string }[] }>;
}

/** Runs a request and waits for the work it left in ctx.waitUntil. */
async function run(req: Request) {
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
	const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], env, ctx);
	await Promise.all(pending);
	return res;
}

beforeEach(async () => {
	env.SETTINGS = fakeKv();
	await setRepoEnabled(env.SETTINGS, "octo/repo", true);
	await setChecksEnabled(env.SETTINGS, "octo/repo", ["closes-issue"], true);
});
afterEach(() => vi.unstubAllGlobals());

describe("webhook handler", () => {
	it("rejects deliveries with a bad signature", async () => {
		const { fetchMock } = mockGitHub();
		const res = await run(delivery("pull_request", { action: "opened", pull_request: pr }, "wrong"));
		expect(res.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails the check when the PR closes nothing", async () => {
		const { checkRuns } = mockGitHub();
		const res = await run(delivery("pull_request", { action: "opened", pull_request: pr }));
		expect(res.status).toBe(200);
		expect(checkRuns).toEqual([
			expect.objectContaining({ name: "Closes an issue", head_sha: "abc123", status: "completed", conclusion: "failure" }),
			expect.objectContaining({ name: "Tests", conclusion: "neutral", output: expect.objectContaining({ title: "Desativado" }) }),
			expect.objectContaining({ name: "Container tests", conclusion: "neutral", output: expect.objectContaining({ title: "Desativado" }) }),
			expect.objectContaining({ name: "Dependabot auto-merge", conclusion: "neutral", output: expect.objectContaining({ title: "Desativado" }) }),
			expect.objectContaining({ name: "Codex review", conclusion: "neutral", output: expect.objectContaining({ title: "Desativado" }) }),
		]);
	});

	it("passes when GitHub reports a linked issue", async () => {
		const { checkRuns } = mockGitHub({ linked: [{ number: 3, repository: { nameWithOwner: "octo/repo" } }] });
		await run(delivery("pull_request", { action: "edited", pull_request: pr }));
		expect(checkRuns[0]).toMatchObject({ conclusion: "success", output: { title: "Closes #3" } });
	});

	it("passes on the no-issue label", async () => {
		const { checkRuns } = mockGitHub();
		await run(delivery("pull_request", { action: "labeled", pull_request: { ...pr, labels: [{ name: "no-issue" }] } }));
		expect(checkRuns[0]).toMatchObject({ conclusion: "success" });
	});

	it("re-fetches the PR when our check run is re-requested", async () => {
		const { checkRuns } = mockGitHub({ fetchedPr: { ...pr, body: "Closes #5" } });
		await run(
			delivery("check_run", {
				action: "rerequested",
				check_run: { name: "Closes an issue", pull_requests: [{ number: 7 }] },
			}),
		);
		expect(checkRuns[0]).toMatchObject({ conclusion: "success", output: { title: "Closes #5" } });
	});

	it("reports a disabled check as neutral without running it", async () => {
		await setChecksEnabled(env.SETTINGS, "Octo/Repo", ["closes-issue"], false);
		const { checkRuns, fetchMock } = mockGitHub();
		await run(delivery("pull_request", { action: "opened", pull_request: pr }));
		expect(checkRuns[0]).toMatchObject({ name: "Closes an issue", conclusion: "neutral", output: { title: "Desativado" } });
		expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/graphql"))).toBe(false);
	});

	it("ignores repositories that were not enabled", async () => {
		await setRepoEnabled(env.SETTINGS, "octo/repo", false);
		const { fetchMock } = mockGitHub();
		const res = await run(delivery("pull_request", { action: "opened", pull_request: pr }));
		expect(res.status).toBe(202);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not treat admin requests as webhooks", async () => {
		const { fetchMock } = mockGitHub();
		const res = await run(new Request("https://worker.example/admin", { method: "POST" }));
		expect(res.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["pull_request", { action: "closed", pull_request: pr }],
		["check_run", { action: "rerequested", check_run: { name: "Other check", pull_requests: [{ number: 7 }] } }],
		["push", {}],
	])("ignores %s deliveries it does not handle", async (event, payload) => {
		const { fetchMock } = mockGitHub();
		const res = await run(delivery(event, payload));
		expect(res.status).toBe(202);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("tests on demand", () => {
	const ran: number[] = [];
	const tests: Check = {
		id: "tests",
		name: "Tests",
		onDemand: true,
		run: async ({ pr }) => {
			ran.push(pr.number);
			return { conclusion: "success", title: "Passou", summary: "" };
		},
	};
	const settings = (onDemand: boolean) => ({ enabled: true, enabledChecks: new Set(["tests"]), onDemand });
	beforeEach(() => {
		ran.length = 0;
	});

	it("completes a push's check run as action required, telling the agent when to ask for a run", async () => {
		const { checkRuns } = mockGitHub();
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([]);
		// Completed, so the check suite finishes and agents waiting for CI wake up to a check that blocks the merge.
		expect(checkRuns).toEqual([
			expect.objectContaining({
				name: "Tests",
				status: "completed",
				conclusion: "action_required",
				output: expect.objectContaining({ title: 'Aguardando "/quality-flare run"', summary: expect.stringContaining("pronta para o merge") }),
			}),
		]);
	});

	it("treats an action-required run as waiting: a push keeps it, the comment says so, a command runs it", async () => {
		const pushed = mockGitHub({ existingRuns: { Tests: "completed:action_required" } });
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(pushed.checkRuns).toEqual([]);
		expect(pushed.comments).toEqual([{ body: expect.stringContaining("| Tests | ⏳ esperando |") }]);

		const commanded = mockGitHub({ existingRuns: { Tests: "completed:action_required" } });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([7]);
		expect(commanded.reactions).toEqual([{ content: "rocket" }]);
	});

	it("keeps one status comment on a ready PR, edited only when what it says changes", async () => {
		const first = mockGitHub();
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(first.comments).toEqual([{ body: expect.stringContaining("### ⏳ Testes: esperando `/quality-flare run` (`abc123`)") }]);
		expect(first.comments[0].body).toContain("pronta para o merge");
		expect(first.comments[0].body).toContain("| Tests | ⏳ esperando |");

		const again = mockGitHub({ existingComments: [{ id: 3, ...first.comments[0] }] });
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(again.comments).toEqual([]);
		expect(again.edits).toEqual([]);

		const container = { ...tests, id: "container-tests", name: "Container tests" };
		const both = { enabled: true, enabledChecks: new Set(["tests", "container-tests"]), onDemand: true };
		const changed = mockGitHub({ existingComments: [{ id: 3, ...first.comments[0] }] });
		await runPlan({ pullRequests: [pr], checks: [tests, container] }, "octo/repo", 99, both, env);
		expect(changed.comments).toEqual([]);
		expect(changed.edits).toEqual([{ id: "3", body: expect.stringContaining("| Container tests | ⏳ esperando |") }]);

		const draft = mockGitHub();
		await runPlan({ pullRequests: [{ ...pr, draft: true }], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(draft.comments).toEqual([]);
	});

	it("edits the status comment when a command runs the tests, and when a push leaves the run behind", async () => {
		const waiting = mockGitHub();
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		const comment = { id: 3, ...waiting.comments[0] };

		const commanded = mockGitHub({ existingComments: [comment] });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(true), env);
		expect(commanded.comments).toEqual([]);
		expect(commanded.edits).toEqual([{ id: "3", body: expect.stringContaining("### ✅ Testes: passaram no commit `abc123`") }]);
		expect(commanded.edits[0].body).toContain("Não faça mais push");

		const pushed = mockGitHub({ existingComments: [{ id: 3, body: commanded.edits[0].body }] });
		await runPlan({ pullRequests: [{ ...pr, head: { sha: "def4567" } }], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(pushed.comments).toEqual([]);
		expect(pushed.edits).toEqual([{ id: "3", body: expect.stringContaining("### ⏳ Testes: esperando `/quality-flare run` (`def4567`)") }]);
		expect(pushed.edits[0].body).toContain("a execução no commit `abc123` não vale para ele");

		// The note stays while the new commit waits, even when something else rewrites the comment.
		const reviewed = mockGitHub({ existingComments: [{ id: 3, body: pushed.edits[0].body }] });
		const container = { ...tests, id: "container-tests", name: "Container tests" };
		const both = { enabled: true, enabledChecks: new Set(["tests", "container-tests"]), onDemand: true };
		await runPlan({ pullRequests: [{ ...pr, head: { sha: "def4567" } }], checks: [tests, container] }, "octo/repo", 99, both, env);
		expect(reviewed.edits[0].body).toContain("a execução no commit `abc123` não vale para ele");
	});

	it("updates the status comment when a test run finishes on the PR's head", async () => {
		const comment = { id: 3, body: "<!-- quality-flare:on-demand -->\nantigo" };
		const finished = (sha: string, appId = 1) => ({ pullRequests: [7], checks: [], finished: { sha, appId } });
		const failed = mockGitHub({ existingComments: [comment], existingRuns: { Tests: "completed:failure" } });
		await runPlan(finished("abc123"), "octo/repo", 99, settings(true), env);
		expect(failed.edits).toEqual([{ id: "3", body: expect.stringContaining("### ❌ Testes: falharam no commit `abc123`") }]);
		expect(failed.edits[0].body).toContain("| Tests | ❌ failure |");

		const other = mockGitHub({ existingComments: [comment], existingRuns: { Tests: "completed:failure" } });
		await runPlan(finished("old999"), "octo/repo", 99, settings(true), env);
		await runPlan(finished("abc123", 42), "octo/repo", 99, settings(true), env);
		expect(other.edits).toEqual([]);

		const running = mockGitHub({ existingComments: [comment], existingRuns: { Tests: "in_progress" } });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(true), env);
		expect(running.reactions).toEqual([{ content: "eyes" }]);
		expect(running.edits).toEqual([{ id: "3", body: expect.stringContaining("### 🏃 Testes: rodando no commit `abc123`") }]);
	});

	it("comments when a draft with a queued check becomes ready for review", async () => {
		const { checkRuns, comments } = mockGitHub({ existingRuns: { Tests: "queued" } });
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(checkRuns).toEqual([]);
		expect(comments).toHaveLength(1);
	});

	it("keeps the passed runs when a push only merges the base into a head that passed", async () => {
		const merged = { ...pr, head: { sha: "mrg999" } };
		const fromBase = { status: "ahead", files: [{ filename: "src/a.ts", status: "modified", sha: "blob1" }] };
		const passed = (name: string, conclusion = "success") => ({ name, status: "completed", conclusion, html_url: `https://github.test/${name}`, output: { title: "Passou" } });
		const fake = (changes: Partial<MergeFake> = {}): MergeFake => ({
			parents: { mrg999: ["abc123", "main01"] },
			runs: { abc123: [passed("Tests"), passed("Typecheck"), passed("Closes an issue", "failure")] },
			compare: { "main01...main": { status: "identical" }, "abc123...main01": fromBase, "abc123...mrg999": fromBase },
			...changes,
		});

		const clean = mockGitHub({ merge: fake() });
		await runPlan({ pullRequests: [merged], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([]);
		// Every run the tests reported comes along, Typecheck included; checks that run on push don't.
		expect(clean.checkRuns).toEqual([
			expect.objectContaining({ name: "Tests", head_sha: "mrg999", conclusion: "success", output: expect.objectContaining({ title: "Reaproveitado de abc123: Passou" }) }),
			expect.objectContaining({ name: "Typecheck", head_sha: "mrg999", conclusion: "success" }),
		]);
		expect(clean.checkRuns[0].output).toEqual(expect.objectContaining({ summary: expect.stringContaining("https://github.test/Tests") }));

		const waits = async (merge: MergeFake) => {
			const github = mockGitHub({ merge });
			await runPlan({ pullRequests: [merged], checks: [tests] }, "octo/repo", 99, settings(true), env);
			expect(github.checkRuns).toEqual([expect.objectContaining({ name: "Tests", conclusion: "action_required" })]);
		};
		// The PR changed a file the base changed too.
		await waits(fake({ compare: { ...fake().compare, "abc123...mrg999": { status: "ahead", files: [{ ...fromBase.files[0], sha: "blob2" }] } } }));
		// The merge changed a file of its own.
		const own = { filename: "src/b.ts", status: "modified", sha: "blob3" };
		await waits(fake({ compare: { ...fake().compare, "abc123...mrg999": { status: "ahead", files: [...fromBase.files, own] } } }));
		// It merged a commit that isn't on the base.
		await waits(fake({ compare: { ...fake().compare, "main01...main": { status: "diverged" } } }));
		// The head it merged into didn't pass.
		await waits(fake({ runs: { abc123: [passed("Tests", "failure")] } }));
		await waits(fake({ runs: { abc123: [passed("Tests"), passed("Typecheck", "failure")] } }));
		// A plain commit.
		await waits(fake({ parents: { mrg999: ["abc123"] } }));
		expect(ran).toEqual([]);
	});

	it("keeps the run a commit already has when the PR leaves draft or reopens", async () => {
		const { checkRuns } = mockGitHub({ existingRuns: { Tests: "queued" } });
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([]);
		expect(checkRuns).toEqual([]);
	});

	it("runs on pushes with the setting off, and on PRs opened by bots", async () => {
		const { checkRuns } = mockGitHub();
		await runPlan({ pullRequests: [pr], checks: [tests] }, "octo/repo", 99, settings(false), env);
		const dependabot = { ...pr, number: 8, user: { login: "dependabot[bot]", type: "Bot" } };
		await runPlan({ pullRequests: [dependabot], checks: [tests] }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([7, 8]);
		expect(checkRuns.map((r) => r.status)).toEqual(["completed", "completed"]);
	});

	it("runs the current head on a run command or a re-run, and reacts to the command", async () => {
		const { reactions } = mockGitHub();
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(true), env);
		await runPlan({ pullRequests: [7], checks: [tests], rerun: true }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([7, 7]);
		expect(reactions).toEqual([{ content: "rocket" }]);
	});

	it("doesn't start a second run when the commit's run is still going, and runs a waiting one", async () => {
		const going = mockGitHub({ existingRuns: { Tests: "in_progress" } });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([]);
		expect(going.checkRuns).toEqual([]);
		expect(going.reactions).toEqual([{ content: "eyes" }]);

		const waiting = mockGitHub({ existingRuns: { Tests: "queued" } });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(true), env);
		expect(ran).toEqual([7]);
		expect(waiting.reactions).toEqual([{ content: "rocket" }]);
	});

	it("runs no tests while the Codex review blocks the PR, and says why", async () => {
		const codex = { login: "chatgpt-codex-connector" };
		const review = (resolved: boolean) => ({
			reviewThreads: { nodes: [{ isResolved: resolved, isOutdated: false, comments: { nodes: [{ author: codex, body: "**Fix the cache**", url: "u" }] } }] },
			reviews: { nodes: [{ author: codex }] },
			comments: { nodes: [] },
			reactionGroups: [],
		});
		const both = { enabled: true, enabledChecks: new Set(["tests", "codex-review"]), onDemand: true };
		const blocked = mockGitHub({ review: review(false) });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, both, env);
		expect(ran).toEqual([]);
		expect(blocked.checkRuns).toEqual([]);
		expect(blocked.comments).toEqual([{ body: expect.stringContaining("### ⏸️ Testes: esperando o Codex review (`abc123`)") }]);
		expect(blocked.comments[0].body).toContain("O último `/quality-flare run` não rodou nada.");
		expect(blocked.comments[0].body).toContain("O **Codex review** ainda bloqueia esta PR (1 sugestão do Codex sem resolver)");
		expect(blocked.reactions).toEqual([{ content: "confused" }]);
		const comment = { id: 3, ...blocked.comments[0] };

		// Another blocked command edits the same comment instead of adding one.
		const again = mockGitHub({ review: review(false), existingComments: [comment] });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, both, env);
		expect(again.comments).toEqual([]);

		// Once the conversation is resolved, the Codex review's own update says the tests can run.
		const settled = mockGitHub({ review: review(true), existingComments: [comment] });
		await runPlan({ pullRequests: [pr], checks: [codexReview] }, "octo/repo", 99, both, env);
		expect(settled.edits).toEqual([{ id: "3", body: expect.stringContaining("### ⏳ Testes: esperando `/quality-flare run` (`abc123`)") }]);

		const clear = mockGitHub({ review: review(true), existingComments: [{ id: 3, body: settled.edits[0].body }] });
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, both, env);
		expect(ran).toEqual([7]);
		expect(clear.comments).toEqual([]);
		expect(clear.edits).toEqual([{ id: "3", body: expect.stringContaining("### ✅ Testes: passaram") }]);
	});

	it("ignores run commands with the setting off", async () => {
		const { checkRuns, reactions } = mockGitHub();
		await runPlan({ pullRequests: [7], checks: [tests], command: { commentId: 5 } }, "octo/repo", 99, settings(false), env);
		expect(ran).toEqual([]);
		expect(checkRuns).toEqual([]);
		expect(reactions).toEqual([]);
	});
});
