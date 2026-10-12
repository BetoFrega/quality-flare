import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/index.ts";
import type { Check } from "../src/checks/types.ts";
import type { RunStore, TestRunDetail } from "../src/runs.ts";
import { getRepoSettings, setChecksEnabled, setRepoEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

const fake = (id: string, name: string): Check => ({ id, name, run: async () => ({ conclusion: "success", title: "", summary: "" }) });
const checks = [fake("closes-issue", "Closes an issue"), fake("other", "Other")];
const repos = [
	{ full_name: "octo/app", html_url: "https://github.com/octo/app", private: false },
	{ full_name: "octo/<secret>", html_url: "https://github.com/octo/secret", private: true },
];
const access = { aud: "aud", getIdentity: async () => ({ email: "me@example.com" }) } as unknown as CloudflareAccessContext;

const NOW = 10 * 60_000;
const history: TestRunDetail[] = [
	{
		id: 2, repo: "octo/app", pr: 4, sha: "bbbbbbbbbb", status: "completed", conclusion: "failure", title: "1 falha em 2 testes",
		startedAt: NOW - 90_000, finishedAt: NOW - 87_500, summary: "",
		report: {
			files: [{
				path: "test/a.test.ts", state: "fail",
				tests: [{ name: "a › adds", state: "pass" }, { name: "a › <subtracts>", state: "fail", errors: ["AssertionError: expected 1 to be 2"] }],
			}],
		},
	},
	{ id: 1, repo: "octo/app", pr: 3, sha: "aaaaaaaaaa", status: "running", conclusion: null, title: null, startedAt: NOW - 45 * 60_000, finishedAt: null, summary: null, report: null },
];
const runs: RunStore = {
	start: async () => 0,
	finish: async () => {},
	list: async () => history,
	get: async (id) => history.find((r) => r.id === id) ?? null,
};

function setup() {
	const env = { ACCESS_AUD: "aud", SETTINGS: fakeKv() } as Env;
	const callAs = (ctxAccess: CloudflareAccessContext | undefined, req: Request) =>
		handleAdmin(req, env, ctxAccess, { checks, listRepos: async () => repos, runs: () => runs, now: () => NOW });
	return { env, callAs, call: (req: Request) => callAs(access, req) };
}

const post = (path: string, fields: Record<string, string>, origin = "https://worker.example") =>
	new Request(`https://worker.example${path}`, {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});

describe("admin", () => {
	it("refuses requests Access did not authenticate", async () => {
		const { callAs } = setup();
		expect((await callAs(undefined, new Request("https://worker.example/admin"))).status).toBe(403);
	});

	it("refuses tokens issued for another Access application", async () => {
		const { callAs } = setup();
		const other = { ...access, aud: "other" } as CloudflareAccessContext;
		expect((await callAs(other, new Request("https://worker.example/admin"))).status).toBe(403);
	});

	it("lists installed repositories, off by default, with their checks collapsed", async () => {
		const { env, call } = setup();
		await setRepoEnabled(env.SETTINGS, "octo/app", true);
		await setChecksEnabled(env.SETTINGS, "octo/app", ["closes-issue"], true);
		const res = await call(new Request("https://worker.example/admin/"));
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain("me@example.com");
		expect(html).toContain("1 de 2 checks ativos");
		expect(html).toContain("0 de 2 checks ativos");
		expect(html).toContain('aria-label="Ativar checks em octo/app"');
		expect(html).toMatch(/aria-checked="true" aria-label="Ativar checks em octo\/app"/);
		expect(html).toMatch(/aria-checked="false" aria-label="Ativar checks em octo\/&#60;secret&#62;"/);
		expect(html).not.toContain("<details open");
		expect(html).not.toContain("<secret>");
	});

	it("expands the repository named in ?open", async () => {
		const { call } = setup();
		const html = await (await call(new Request("https://worker.example/admin?open=octo%2Fapp"))).text();
		expect(html.match(/<details open/g)).toHaveLength(1);
		expect(html).toMatch(/<details open>\s*<summary>\s*<span class="name">octo\/app/);
	});

	it("enables a repository", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/repos", { repo: "octo/app", enabled: "true" }));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("https://worker.example/admin#octo%2Fapp");
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabled).toBe(true);
	});

	it("toggles one check and keeps the repository expanded", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/checks", { repo: "octo/app", check: "other", enabled: "true" }));
		expect(res.headers.get("Location")).toBe("https://worker.example/admin?open=octo%2Fapp#octo%2Fapp");
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabledChecks).toEqual(new Set(["other"]));
	});

	it("enables and disables every check of a repository at once", async () => {
		const { env, call } = setup();
		await call(post("/admin/checks/all", { repo: "octo/app", enabled: "true" }));
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabledChecks).toEqual(new Set(["closes-issue", "other"]));
		await call(post("/admin/checks/all", { repo: "octo/app", enabled: "false" }));
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabledChecks).toEqual(new Set());
	});

	it("rejects cross-site posts", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/repos", { repo: "octo/app", enabled: "true" }, "https://evil.example"));
		expect(res.status).toBe(403);
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabled).toBe(false);
	});

	it.each([
		["/admin/repos", { repo: "octo/not-installed", enabled: "true" }],
		["/admin/checks", { repo: "octo/app", check: "unknown", enabled: "true" }],
	])("rejects unknown repositories and checks: %s", async (path, fields) => {
		const { call } = setup();
		expect((await call(post(path, fields))).status).toBe(400);
	});

	it("lists test runs, flagging runs that never finished", async () => {
		const { call } = setup();
		const page = await (await call(new Request("https://worker.example/admin/runs"))).text();
		expect(page).toContain('<a href="/admin/runs/2">✗ Falhou</a>');
		expect(page).toContain("1 falha em 2 testes");
		expect(page).toContain("2.5 s");
		expect(page).toContain('<a href="/admin/runs/1">! Interrompida</a>');
		// No ever-growing duration for a run that died.
		expect(page).not.toContain("45 min 0 s");
		expect(page).toContain(`<td class="num">—</td>`);
		expect(page).not.toContain('http-equiv="refresh"');
	});

	it("falls back to reloading without JavaScript while tests are running", async () => {
		const { env } = setup();
		const fresh = { ...history[1], startedAt: NOW - 10_000 };
		const store = { ...runs, list: async () => [fresh] };
		const res = await handleAdmin(new Request("https://worker.example/admin/runs"), env, access, { checks, runs: () => store, now: () => NOW });
		const page = await res.text();
		expect(page).toContain("● Rodando");
		expect(page).toContain('<meta http-equiv="refresh" content="5">');
	});

	it("shows each test of a run, escaping names and errors", async () => {
		const { call } = setup();
		const page = await (await call(new Request("https://worker.example/admin/runs/2"))).text();
		expect(page).toContain("test/a.test.ts");
		expect(page).toContain("a › &#60;subtracts&#62;");
		expect(page).toContain("<pre>AssertionError: expected 1 to be 2</pre>");
		expect((await call(new Request("https://worker.example/admin/runs/9"))).status).toBe(404);
	});

	it("serves the live script and only accepts same-origin WebSockets for live updates", async () => {
		const { call } = setup();
		const script = await call(new Request("https://worker.example/admin/live.js"));
		expect(script.headers.get("Content-Type")).toContain("javascript");
		expect(await script.text()).toContain("/admin/live?run=");
		expect((await call(new Request("https://worker.example/admin/live"))).status).toBe(426);
		const foreign = new Request("https://worker.example/admin/live?run=all", { headers: { Upgrade: "websocket", Origin: "https://evil.example" } });
		expect((await call(foreign)).status).toBe(403);
	});

	it("loads the live script on run pages", async () => {
		const { call } = setup();
		const res = await call(new Request("https://worker.example/admin/runs"));
		expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
		const page = await res.text();
		expect(page).toContain('<main data-live="all">');
		expect(page).toContain('<script src="/admin/live.js" defer></script>');
	});
});
