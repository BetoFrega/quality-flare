import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/index.ts";
import type { Check } from "../src/checks/types.ts";
import { getRepoSettings, setChecksEnabled, setRepoEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

const fake = (id: string, name: string): Check => ({ id, name, run: async () => ({ conclusion: "success", title: "", summary: "" }) });
const checks = [fake("closes-issue", "Closes an issue"), fake("other", "Other")];
const repos = [
	{ full_name: "octo/app", html_url: "https://github.com/octo/app", private: false },
	{ full_name: "octo/<secret>", html_url: "https://github.com/octo/secret", private: true },
];
const access = { aud: "aud", getIdentity: async () => ({ email: "me@example.com" }) } as unknown as CloudflareAccessContext;

function setup() {
	const env = { ACCESS_AUD: "aud", SETTINGS: fakeKv() } as Env;
	const callAs = (ctxAccess: CloudflareAccessContext | undefined, req: Request) =>
		handleAdmin(req, env, ctxAccess, { checks, listRepos: async () => repos });
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
});
