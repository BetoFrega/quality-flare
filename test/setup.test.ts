import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { checksFor } from "../src/checks/index.ts";
import { appConfigured, handleSetup, manifest, PENDING } from "../src/setup.ts";

const ready = { GITHUB_APP_ID: "42", GITHUB_PRIVATE_KEY: "pem", GITHUB_WEBHOOK_SECRET: "s", PUBLIC_URL: "https://qf.example", ACCESS_AUD: "aud" } as Env;
const fresh = { GITHUB_APP_ID: PENDING, GITHUB_PRIVATE_KEY: PENDING, GITHUB_WEBHOOK_SECRET: PENDING, PUBLIC_URL: "", ACCESS_AUD: "" } as Env;
const BASE = "https://quality-flare.acme.workers.dev";
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, { headers });

describe("setup", () => {
	it("treats missing or placeholder App secrets as not set up", () => {
		expect(appConfigured(ready)).toBe(true);
		expect(appConfigured(fresh)).toBe(false);
		expect(appConfigured({ ...ready, GITHUB_WEBHOOK_SECRET: "" } as Env)).toBe(false);
	});

	it("lists what is missing, with this Worker's address as PUBLIC_URL", async () => {
		const page = await (await handleSetup(get("/setup"), fresh)).text();
		expect(page).toContain("Criar a GitHub App");
		expect(page).toContain(`<code>${BASE}</code>`);
		expect(page).toContain("ACCESS_AUD");
		const done = await (await handleSetup(get("/setup"), ready)).text();
		expect(done).toContain("Tudo pronto");
		expect(done).toContain("App ID 42");
		expect(done).not.toContain("Criar a GitHub App");
	});

	it("without Workers Paid, drops the Tests checks and says so", async () => {
		const free = { ...ready, TESTS_OFF: "free-plan" } as Env;
		expect(checksFor(ready).map((c) => c.id)).toEqual(expect.arrayContaining(["tests", "container-tests"]));
		expect(checksFor(free).map((c) => c.id)).not.toEqual(expect.arrayContaining(["tests"]));
		expect(checksFor(free).map((c) => c.id)).toContain("closes-issue");
		expect(checksFor(free).some((c) => c.onDemand)).toBe(false);
		const page = await (await handleSetup(get("/setup"), free)).text();
		expect(page).toContain("Workers Paid");
		expect(page).toContain("Tudo pronto");
		expect(await (await handleSetup(get("/setup"), ready)).text()).not.toContain("Workers Paid");
	});

	it("asks GitHub for an App whose webhook and redirect point here", () => {
		expect(manifest(new URL(`${BASE}/setup/github`))).toMatchObject({
			name: "quality-flare-acme",
			hook_attributes: { url: `${BASE}/` },
			redirect_url: `${BASE}/setup/github/callback`,
			public: false,
			default_permissions: { checks: "write", contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
		});
	});

	it("posts the manifest to the person's account or an organization, remembering the state", async () => {
		const res = await handleSetup(get("/setup/github?org=octo"), fresh, { random: () => "st4te" });
		const page = await res.text();
		expect(page).toContain('action="https://github.com/organizations/octo/settings/apps/new?state=st4te"');
		expect(page).toContain("&#34;default_events&#34;");
		expect(res.headers.get("Set-Cookie")).toContain("qf_setup_state=st4te");
		const personal = await (await handleSetup(get("/setup/github?org="), fresh, { random: () => "x" })).text();
		expect(personal).toContain('action="https://github.com/settings/apps/new?state=x"');
		expect((await handleSetup(get("/setup/github?org=a/b"), fresh)).status).toBe(400);
	});

	it("shows the new App's credentials once, only to the browser that started", async () => {
		const fetch = vi.fn(async () => Response.json({ id: 7, slug: "quality-flare-acme", html_url: "https://github.com/apps/quality-flare-acme", pem: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n", webhook_secret: "whs" }));
		const forged = await handleSetup(get("/setup/github/callback?code=c0de&state=st4te", { Cookie: "qf_setup_state=other" }), fresh, { fetch });
		expect(forged.status).toBe(400);
		expect(fetch).not.toHaveBeenCalled();

		const res = await handleSetup(get("/setup/github/callback?code=c0de&state=st4te", { Cookie: "a=1; qf_setup_state=st4te" }), fresh, { fetch });
		expect(fetch).toHaveBeenCalledWith("https://api.github.com/app-manifests/c0de/conversions", expect.objectContaining({ method: "POST" }));
		const page = await res.text();
		expect(page).toContain("whs");
		expect(page).toContain("BEGIN RSA PRIVATE KEY");
		expect(page).toContain("https://github.com/apps/quality-flare-acme/installations/new");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("creates no App once this Worker has one", async () => {
		const fetch = vi.fn();
		for (const path of ["/setup/github", "/setup/github/callback?code=c&state=s"]) {
			const res = await handleSetup(get(path, { Cookie: "qf_setup_state=s" }), ready, { fetch });
			expect(res.status).toBe(303);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("worker before setup", () => {
	const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

	it("sends visitors to /setup and refuses webhooks signed with the placeholder", async () => {
		const home = await worker.fetch(get("/") as Parameters<typeof worker.fetch>[0], fresh, ctx);
		expect(home.status).toBe(302);
		expect(home.headers.get("Location")).toBe(`${BASE}/setup`);
		const hook = await worker.fetch(new Request(`${BASE}/`, { method: "POST", body: "{}" }) as Parameters<typeof worker.fetch>[0], fresh, ctx);
		expect(hook.status).toBe(503);
		const turbo = await worker.fetch(get("/turbo/v8/artifacts/abc") as Parameters<typeof worker.fetch>[0], fresh, ctx);
		expect(turbo.status).toBe(503);
	});

	it("says what is left once the App exists", async () => {
		const res = await worker.fetch(get("/") as Parameters<typeof worker.fetch>[0], { ...ready, ACCESS_AUD: "" } as Env, ctx);
		expect(await res.text()).toContain("/setup");
	});
});
