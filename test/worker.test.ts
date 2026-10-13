import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
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
function mockGitHub({ linked = [] as { number: number; repository: { nameWithOwner: string } }[], fetchedPr = pr } = {}) {
	const checkRuns: Record<string, unknown>[] = [];
	const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname;
		if (path === "/app/installations/99/access_tokens") return Response.json({ token: "inst-token" });
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer inst-token");
		if (path === "/graphql")
			return Response.json({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: linked } } } } });
		if (path === "/repos/octo/repo/pulls/7") return Response.json(fetchedPr);
		if (path === "/repos/octo/repo/check-runs") {
			checkRuns.push(JSON.parse(init.body as string));
			return Response.json({ id: 1 }, { status: 201 });
		}
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { checkRuns, fetchMock };
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
