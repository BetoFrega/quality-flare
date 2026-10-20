import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { PENDING } from "../src/setup.ts";

const ready = { GITHUB_APP_ID: "42", GITHUB_PRIVATE_KEY: "pem", GITHUB_WEBHOOK_SECRET: "s", PUBLIC_URL: "https://qf.example", ACCESS_AUD: "aud" } as Env;
const fresh = { GITHUB_APP_ID: PENDING, GITHUB_PRIVATE_KEY: PENDING, GITHUB_WEBHOOK_SECRET: PENDING, PUBLIC_URL: "", ACCESS_AUD: "" } as Env;
// The Tests check runs these files in a Dynamic Worker, without the build (build/docs.ts, virtual:docs).
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const build = () => import("../build/docs.ts");
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const get = (path: string, env: Env) => worker.fetch(new Request(`https://quality-flare.acme.workers.dev${path}`), env, ctx);

describe("site", () => {
	it("serves the home page at the root once the App exists", async () => {
		const res = await get("/", ready);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const page = await res.text();
		expect(page).toContain("Continuous integration that runs entirely on Cloudflare");
		expect(page).not.toContain("Finish setting it up");
		expect(await (await get("/", { ...ready, ACCESS_AUD: "" } as Env)).text()).toContain("Finish setting it up");
	});

	it("still sends a new installation's root to /setup", async () => {
		const res = await get("/", fresh);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://quality-flare.acme.workers.dev/setup");
	});

	it.skipIf(inWorkers)("serves every docs page, before and after setup, with the sidebar", async () => {
		const { PAGES } = await build();
		for (const env of [ready, fresh]) {
			const intro = await get("/docs", env);
			expect(intro.status).toBe(200);
			expect(await intro.text()).toContain('<a href="/docs" aria-current="page">Introduction</a>');
			for (const slug of PAGES.filter((s) => s !== "index")) {
				const res = await get(`/docs/${slug}/`, env);
				expect(res.status, slug).toBe(200);
				expect(await res.text()).toContain(`<a href="/docs/${slug}" aria-current="page">`);
			}
		}
		expect((await get("/docs/nope", ready)).status).toBe(404);
	});

	it.skipIf(inWorkers)("turns links between Markdown files into links between pages, with GitHub's anchors", async () => {
		const { renderDoc } = await build();
		const { title, html } = renderDoc("x", "# Title\n\n## Only the tests that changed\n\nSee [tests](checks.md#tests), [home](index.md), [code](../src/index.ts).");
		expect(title).toBe("Title");
		expect(html).toContain('id="only-the-tests-that-changed"');
		expect(html).toContain('href="/docs/checks#tests"');
		expect(html).toContain('href="/docs"');
		expect(html).toContain('href="https://github.com/BetoFrega/quality-flare/blob/main/src/index.ts"');
		expect(() => renderDoc("x", "# T\n\n[x](missing.md)")).toThrow(/not in PAGES/);
	});

	it.skipIf(inWorkers)("links only to anchors that exist", async () => {
		const { PAGES } = await build();
		const pages = await Promise.all(PAGES.map(async (slug) => (await get(slug === "index" ? "/docs" : `/docs/${slug}`, ready)).text()));
		const ids = new Map(PAGES.map((slug, i) => [slug, new Set([...pages[i].matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
		const home = await (await get("/", ready)).text();
		for (const page of [...pages, home]) {
			for (const [, slug = "index", anchor] of page.matchAll(/href="\/docs(?:\/([a-z-]+))?#([^"]+)"/g)) {
				expect(ids.get(slug)?.has(anchor), `${slug}#${anchor}`).toBe(true);
			}
		}
	});
});
