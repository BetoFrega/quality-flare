import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/index.ts";
import type { Check } from "../src/checks/types.ts";
import type { MetricsStore, Usage } from "../src/metrics.ts";
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
	{ id: 1, repo: "octo/app", pr: 3, sha: "aaaaaaaaaa", status: "running", conclusion: null, title: null, startedAt: NOW - 90 * 60_000, finishedAt: null, summary: null, report: null },
];
const runs: RunStore = {
	start: async () => 0,
	finish: async () => {},
	list: async () => history,
	repos: async () => ["octo/app"],
	get: async (id) => history.find((r) => r.id === id) ?? null,
};

const usage: Usage = { attempts: 12, retries: 2, crashes: 1, splits: 2, dynamicWorkers: 10, cpuMs: 45_000, wallMs: 600_000 };
const box = { runs: 1, wallMs: 600_000, cpuUs: 1_200_000_000, unmeasured: 0 };
const metrics: MetricsStore = {
	start: async () => {},
	finish: async () => {},
	trace: async () => {},
	byRun: async (ids) => new Map(ids.filter((id) => id === 2).map((id) => [id, usage])),
	attempts: async (runId) =>
		runId === 2
			? [
					{ runId, shard: "0", attempt: 1, files: 5, startedAt: NOW - 90_000, finishedAt: null, outcome: null, codeBytes: null, dynamicWorker: true, cpuMs: 900, dwWallMs: 1000, dwOutcome: "exceededMemory" },
					{ runId, shard: "0", attempt: 2, files: 5, startedAt: NOW - 60_000, finishedAt: NOW - 59_000, outcome: "split", codeBytes: null, dynamicWorker: false, cpuMs: null, dwWallMs: null, dwOutcome: null },
				]
			: [],
	usage: async (by, _since, repo) => [{ period: by === "day" ? "1970-01-01" : "1970-01", repo: repo ?? null, runs: 1, ...usage }],
	// 10 minutes on, 20 minutes of vCPU.
	containersByRun: async (ids) => new Map(ids.filter((id) => id === 1).map((id) => [id, box])),
	containerUsage: async (by) => [{ period: by === "day" ? "1970-01-01" : "1970-01", ...box }],
};

const account = {
	days: [{ date: "1970-01-01", dynamicWorkers: 1_500, cpuMs: 2_000_000, requests: 900, errors: 3, accountCpuMs: 2_100_000, containers: { memoryGiBs: 1_000, vcpuS: 60, diskGBs: 2_000 } }],
	// 40,000 GiB-s of memory past the 90,000 included.
	month: { period: "1970-01", dynamicWorkers: 1_500, cpuMs: 2_000_000, requests: 900, errors: 3, accountCpuMs: 2_100_000, containers: { memoryGiBs: 130_000, vcpuS: 600, diskGBs: 7_200 } },
};

function setup() {
	const env = { ACCESS_AUD: "aud", SETTINGS: fakeKv() } as Env;
	const callAs = (ctxAccess: CloudflareAccessContext | undefined, req: Request) =>
		handleAdmin(req, env, ctxAccess, { checks, listRepos: async () => repos, runs: () => runs, metrics: () => metrics, account: async () => account, installUrl: async () => "https://github.com/apps/qf-test/installations/new", now: () => NOW });
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

	it("stays closed, pointing to /setup, until an Access application is configured", async () => {
		const { env, call } = setup();
		env.ACCESS_AUD = "";
		const res = await call(new Request("https://worker.example/admin"));
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("/setup");
	});

	it("says why the Tests checks are missing when the deploy left them out", async () => {
		const { env, call } = setup();
		expect(await (await call(new Request("https://worker.example/admin"))).text()).not.toContain("Workers Paid");
		env.TESTS_OFF = "free-plan";
		expect(await (await call(new Request("https://worker.example/admin"))).text()).toContain("Workers Paid");
	});

	it("links to this installation's own App for installing on more repositories", async () => {
		const { call } = setup();
		expect(await (await call(new Request("https://worker.example/admin"))).text()).toContain("https://github.com/apps/qf-test/installations/new");
	});

	it("links to this installation's docs and to the project's site", async () => {
		const { call } = setup();
		const page = await (await call(new Request("https://worker.example/admin"))).text();
		expect(page).toContain('<a href="/docs">Docs</a>');
		expect(page).toContain('<a href="https://quality-flare.frega.dev">Site</a>');
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
		expect(html).toContain("nenhum check roda: repositório desativado");
		expect(html).toMatch(/id="octo\/app:repo" role="switch" aria-checked="true" aria-label="Checks do quality-flare em octo\/app"/);
		expect(html).toMatch(/aria-checked="false" aria-label="Checks do quality-flare em octo\/&#60;secret&#62;">\s*<span class="track"><span class="thumb"><\/span><\/span><span class="label">Desativado</);
		expect(html).not.toContain("<details open");
		expect(html).not.toContain('role="status"');
	});

	it("warns that turning an enabled repository off blocks the checks branch protection requires", async () => {
		const { env, call } = setup();
		await setRepoEnabled(env.SETTINGS, "octo/app", true);
		const html = await (await call(new Request("https://worker.example/admin"))).text();
		const warning = /<p class="note warn" id="octo\/app:warning">([^<]+)<\/p>/.exec(html)?.[1];
		expect(warning).toContain("trava o merge");
		expect(warning).toContain("Desativar todos");
		expect(html).toMatch(new RegExp(`id="octo/app:repo"[^>]*aria-describedby="octo/app:warning" title="${warning}"`));
		expect(html.match(/class="note warn"/g)).toHaveLength(1);
		expect(html).not.toContain("<secret>");
	});

	it("expands the repository named in ?open", async () => {
		const { call } = setup();
		const html = await (await call(new Request("https://worker.example/admin?open=octo%2Fapp"))).text();
		expect(html.match(/<details open/g)).toHaveLength(1);
		expect(html).toMatch(/<details open>\s*<summary>\s*<span class="name">octo\/app/);
	});

	it("filters repositories by name and state, and sorts them", async () => {
		const { env, call } = setup();
		await setRepoEnabled(env.SETTINGS, "octo/<secret>", true);
		const names = (html: string) => [...html.matchAll(/<span class="name">([^<]+)<\/span>/g)].map((m) => m[1]);

		expect(names(await (await call(new Request("https://worker.example/admin"))).text())).toEqual(["octo/&#60;secret&#62;", "octo/app"]);
		expect(names(await (await call(new Request("https://worker.example/admin?sort=name-desc"))).text())).toEqual(["octo/app", "octo/&#60;secret&#62;"]);
		expect(names(await (await call(new Request("https://worker.example/admin?q=APP"))).text())).toEqual(["octo/app"]);
		const disabled = await (await call(new Request("https://worker.example/admin?status=disabled&sort=bogus"))).text();
		expect(names(disabled)).toEqual(["octo/app"]);
		expect(disabled).toContain("nenhum check roda");
		expect(disabled).toContain('<option value="disabled" selected>');
		expect(disabled).toContain('<option value="name" selected>');
		expect(await (await call(new Request("https://worker.example/admin?q=nothing"))).text()).toContain("Nenhum repositório com esses filtros");
	});

	it("keeps the filters after a change", async () => {
		const { call } = setup();
		const page = await (await call(new Request("https://worker.example/admin?q=app&sort=enabled"))).text();
		expect(page).toContain('<input type="hidden" name="back" value="q=app&#38;sort=enabled">');
		const res = await call(post("/admin/checks", { repo: "octo/app", check: "other", enabled: "true", back: "q=app&sort=enabled&evil=1" }));
		expect(res.headers.get("Location")).toBe("https://worker.example/admin?q=app&sort=enabled&open=octo%2Fapp&changed=octo%2Fapp%3Acheck%3Aother#octo%2Fapp%3Acheck%3Aother");
	});

	it("enables a repository", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/repos", { repo: "octo/app", enabled: "true" }));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("https://worker.example/admin?changed=octo%2Fapp%3Arepo#octo%2Fapp%3Arepo");
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabled).toBe(true);
	});

	it("toggles one check and keeps the repository expanded", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/checks", { repo: "octo/app", check: "other", enabled: "true" }));
		expect(res.headers.get("Location")).toBe("https://worker.example/admin?open=octo%2Fapp&changed=octo%2Fapp%3Acheck%3Aother#octo%2Fapp%3Acheck%3Aother");
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabledChecks).toEqual(new Set(["other"]));
	});

	it("returns focus to the switch that was used and confirms the change there", async () => {
		const { env, call } = setup();
		await setChecksEnabled(env.SETTINGS, "octo/app", ["other"], true);
		const html = await (await call(new Request("https://worker.example/admin?open=octo%2Fapp&changed=octo%2Fapp%3Acheck%3Aother"))).text();
		expect(html).toMatch(/id="octo\/app:check:other" role="switch" aria-checked="true" aria-label="Other em octo\/app" aria-describedby="octo\/app:check:other-status">/);
		expect(html).toContain('<span class="saved" role="status" id="octo/app:check:other-status">Salvo</span>');
		expect(html.match(/role="status"/g)).toHaveLength(1);
		// The confirmation is not carried into the forms' filter round-trip.
		expect(html).not.toContain('name="back"');
	});

	it("enables and disables every check of a repository at once", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/checks/all", { repo: "octo/app", enabled: "true" }));
		expect(res.headers.get("Location")).toBe("https://worker.example/admin?open=octo%2Fapp&changed=octo%2Fapp%3Achecks#octo%2Fapp%3Achecks");
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabledChecks).toEqual(new Set(["closes-issue", "other"]));
		const page = await (await call(new Request("https://worker.example/admin?open=octo%2Fapp&changed=octo%2Fapp%3Achecks"))).text();
		expect(page).toContain('<p class="saved" role="status" id="octo/app:checks-status">Salvo: 2 de 2 checks ativos.</p>');
		expect(page).toContain('<ul class="checks" id="octo/app:checks" tabindex="-1" aria-describedby="octo/app:checks-status">');
		await call(post("/admin/checks/all", { repo: "octo/app", enabled: "false" }));
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).enabledChecks).toEqual(new Set());
	});

	it("turns tests on demand on for a repository", async () => {
		const { env, call } = setup();
		const res = await call(post("/admin/on-demand", { repo: "octo/app", enabled: "true" }));
		expect(res.headers.get("Location")).toBe("https://worker.example/admin?open=octo%2Fapp&changed=octo%2Fapp%3Aon-demand#octo%2Fapp%3Aon-demand");
		expect((await getRepoSettings(env.SETTINGS, "octo/app")).onDemand).toBe(true);
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
		expect(page).not.toContain("90 min 0 s");
		expect(page).toContain(`<td class="num">—</td>`);
		expect(page).not.toContain('http-equiv="refresh"');
	});

	it("filters and sorts test runs from the query string", async () => {
		const { env } = setup();
		const queries: unknown[] = [];
		const store: RunStore = { ...runs, list: async (query) => (queries.push(query), []) };
		const call = (path: string) => handleAdmin(new Request(`https://worker.example${path}`), env, access, { checks, runs: () => store, now: () => NOW });
		const page = await (await call("/admin/runs?repo=octo%2Fapp&state=failure&sort=longest")).text();
		expect(queries[0]).toEqual({ repo: "octo/app", state: "failure", sort: "longest" });
		expect(page).toContain('<option value="octo/app" selected>');
		expect(page).toContain('<option value="failure" selected>Falhou</option>');
		expect(page).toContain('<option value="longest" selected>');
		expect(page).toContain("Nenhuma execução com esses filtros");
		await call("/admin/runs?state=whatever&sort=x");
		expect(queries[1]).toEqual({ repo: undefined, state: undefined, sort: undefined });
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

	it("shows what each run used and an estimated cost", async () => {
		const { call } = setup();
		const list = await (await call(new Request("https://worker.example/admin/runs"))).text();
		// 10 Dynamic Workers × US$ 0.002 + 45,000 ms of CPU + requests and queue operations
		expect(list).toContain('<td class="num">10 <span class="failure" title="quedas">1✗</span></td><td class="num">US$ 0.02</td>');
		// A container run: 12 GiB and 20 GB for 600 s, plus 1,200 vCPU-s.
		expect(list).toContain('<td class="num"><span title="Rodou num container">—</span></td><td class="num">US$ 0.04</td>');
		const page = await (await call(new Request("https://worker.example/admin/runs/2"))).text();
		expect(page).toContain("Uso e custo");
		expect(page).toContain("<dt>Quedas (memória)</dt><dd>1</dd>");
		expect(page).toContain("Caiu (consumer sem memória?)");
		expect(page).toContain('<span class="failure">exceededMemory</span>');
		expect(page).toContain("Dividido (queda antes)");
	});

	it("leaves the usage out of a run that has none recorded, or when it can't be read", async () => {
		const { env } = setup();
		const broken: MetricsStore = { ...metrics, byRun: async () => Promise.reject(new Error("D1 down")) };
		const res = await handleAdmin(new Request("https://worker.example/admin/runs"), env, access, { checks, runs: () => runs, metrics: () => broken, now: () => NOW });
		expect(res.status).toBe(200);
		const { call } = setup();
		expect(await (await call(new Request("https://worker.example/admin/runs/1"))).text()).not.toContain("Uso e custo");
	});

	it("totals usage and cost per day and month, per repository", async () => {
		const { call } = setup();
		const page = await (await call(new Request("https://worker.example/admin/costs?repo=octo%2Fapp"))).text();
		expect(page).toContain('<a href="/admin/costs" aria-current="page">Custos</a>');
		expect(page).toContain('<option value="octo/app" selected>');
		expect(page).toContain('<td class="mono">1970-01-01</td>');
		expect(page).toContain("<h3>Testes, mês 1970-01</h3>");
		// Under the monthly allowances, a month costs nothing.
		expect(page).toContain("<dt>Após franquia</dt><dd>US$ 0</dd>");
		// The account's measured usage: 500 Dynamic Workers past the 1,000 included, and 40,000 GiB-s of container memory.
		expect(page).toContain("<dt>Cobrança estimada do mês</dt><dd>US$ 1.10</dd>");
		expect(page).toContain("<dt>Dynamic Workers</dt><dd>1.500 de 1.000</dd>");
		expect(page).toContain("<dt>Memória dos containers</dt><dd>36,1 de 25 GiB-h</dd>");
		expect(page).toContain("<dt>Containers após franquia</dt><dd>US$ 0.10</dd>");
		// The Container tests estimate.
		expect(page).toContain("<h3>Containers, mês 1970-01</h3>");
		expect(page).toContain("<dt>Custo estimado</dt><dd>US$ 0.04</dd>");
		expect(page).toContain("<dt>CPU dos containers</dt><dd>20 de 375 vCPU-min</dd>");
	});

	it("says why the account's usage is missing", async () => {
		const { env } = setup();
		const res = await handleAdmin(new Request("https://worker.example/admin/costs"), env, access, {
			checks,
			runs: () => runs,
			metrics: () => metrics,
			account: async () => Promise.reject(new Error("GraphQL Analytics: 403")),
			now: () => NOW,
		});
		expect(await res.text()).toContain("Não deu para ler o uso real da conta: GraphQL Analytics: 403");
	});
});
