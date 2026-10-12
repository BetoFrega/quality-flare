import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin/index.ts";
import type { Check } from "../src/checks/types.ts";
import { getDisabledChecks, setCheckEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

const checks: Check[] = [
	{ id: "closes-issue", name: "Closes an issue", run: async () => ({ conclusion: "success", title: "", summary: "" }) },
];
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

const toggle = (fields: Record<string, string>, origin = "https://worker.example") =>
	new Request("https://worker.example/admin/checks", {
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

	it("lists installed repositories with each check's state", async () => {
		const { env, call } = setup();
		await setCheckEnabled(env.SETTINGS, "octo/app", "closes-issue", false);
		const res = await call(new Request("https://worker.example/admin/"));
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain("me@example.com");
		expect(html).toMatch(/octo\/app[\s\S]*aria-checked="false"[\s\S]*octo\/&#60;secret&#62;[\s\S]*aria-checked="true"/);
		expect(html).not.toContain("<secret>");
	});

	it("toggles a check and redirects back", async () => {
		const { env, call } = setup();
		const res = await call(toggle({ repo: "octo/app", check: "closes-issue", enabled: "false" }));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("https://worker.example/admin#octo%2Fapp");
		expect(await getDisabledChecks(env.SETTINGS, "octo/app")).toEqual(new Set(["closes-issue"]));
	});

	it("rejects cross-site posts", async () => {
		const { env, call } = setup();
		const res = await call(toggle({ repo: "octo/app", check: "closes-issue", enabled: "false" }, "https://evil.example"));
		expect(res.status).toBe(403);
		expect(await getDisabledChecks(env.SETTINGS, "octo/app")).toEqual(new Set());
	});

	it.each([
		[{ repo: "octo/not-installed", check: "closes-issue", enabled: "false" }],
		[{ repo: "octo/app", check: "unknown", enabled: "false" }],
	])("rejects unknown repositories and checks: %o", async (fields) => {
		const { call } = setup();
		expect((await call(toggle(fields))).status).toBe(400);
	});
});
