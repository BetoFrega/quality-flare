import { describe, expect, it } from "vitest";
import { buildModules, MAIN_MODULE, type TestBundle } from "../../../src/checks/tests/modules.ts";
import type { TestReport } from "../../../src/checks/tests/report.ts";

/** A small repository: one passing file, one with failures, one that can't load. */
const REPO = {
	"package.json": JSON.stringify({ name: "fixture" }),
	"src/math.ts": "export const add = (a: number, b: number): number => a + b;",
	"test/math.test.ts": `
		import { beforeEach, describe, expect, it, vi } from "vitest";
		import { add } from "../src/math";
		import { createHash } from "node:crypto";

		describe("add", () => {
			let calls = 0;
			beforeEach(() => { calls++; });
			it("adds", () => expect(add(1, 2)).toBe(3));
			it("matches objects", () => expect({ a: 1, b: [2] }).toEqual(expect.objectContaining({ b: [2] })));
			it("ran beforeEach", () => expect(calls).toBe(3));
			it("spies and stubs globals", async () => {
				const fetch = vi.fn(async () => new Response("stubbed"));
				vi.stubGlobal("fetch", fetch);
				expect(await (await globalThis.fetch("https://example.com")).text()).toBe("stubbed");
				expect(fetch).toHaveBeenCalledWith("https://example.com");
				vi.unstubAllGlobals();
			});
			it("has Node APIs", () => expect(createHash("sha256").update("a").digest("hex")).toMatch(/^ca978112/));
			it.skip("is skipped", () => {});
		});`,
	"test/fail.test.ts": `
		import { expect, it } from "vitest";
		it("fails an assertion", () => expect(1 + 1).toBe(3));
		it("counts assertions", () => { expect.assertions(2); expect(true).toBe(true); });`,
	"test/broken.test.ts": `import pad from "left-pad"; import { it } from "vitest"; it("never runs", () => pad);`,
};

const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";

// Starts workerd itself, so it only runs under Node (it is skipped when the Tests check runs this suite).
describe.skipIf(inWorkers)("tests in a Dynamic Worker", () => {
	it("runs each test file with vitest's runner and reports every test", async () => {
		const { default: runtimeSource } = await import("virtual:test-runtime");
		const bundle = await buildModules(new Map(Object.entries(REPO)), {
			runtimeSource,
			fetchPackage: () => Promise.reject(new Error("offline")),
		});
		const report = await runInWorkerd(bundle);

		const byPath = Object.fromEntries(report.files.map((f) => [f.path, f]));
		expect(Object.keys(byPath)).toEqual(["test/broken.test.ts", "test/fail.test.ts", "test/math.test.ts"]);
		expect(byPath["test/math.test.ts"].tests.map((t) => [t.name, t.state])).toEqual([
			["add › adds", "pass"],
			["add › matches objects", "pass"],
			["add › ran beforeEach", "pass"],
			["add › spies and stubs globals", "pass"],
			["add › has Node APIs", "pass"],
			["add › is skipped", "skip"],
		]);
		const [assertion, count] = byPath["test/fail.test.ts"].tests;
		expect(assertion).toMatchObject({ state: "fail", errors: [expect.stringContaining("expected 2 to be 3")] });
		expect(count).toMatchObject({ state: "fail", errors: [expect.stringContaining("expected number of assertions to be 2, but got 1")] });
		expect(byPath["test/broken.test.ts"]).toMatchObject({ state: "fail", errors: [expect.stringContaining("left-pad")] });
	}, 30_000);
});

/** Serves a host Worker with a Worker Loader binding on workerd and has it run the bundle. */
async function runInWorkerd(bundle: TestBundle): Promise<TestReport> {
	const [{ spawn }, { mkdtemp, writeFile, rm }, { tmpdir }, { join }, { createServer }, { createRequire }] = await Promise.all([
		import("node:child_process"),
		import("node:fs/promises"),
		import("node:os"),
		import("node:path"),
		import("node:net"),
		import("node:module"),
	]);
	const port = await new Promise<number>((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
	const dir = await mkdtemp(join(tmpdir(), "qf-workerd-"));
	await writeFile(join(dir, "bundle.json"), JSON.stringify(bundle));
	await writeFile(
		join(dir, "host.js"),
		`import bundle from "bundle.json";
export default { async fetch(request, env) {
	const worker = env.LOADER.load({ compatibilityDate: "2026-10-06", compatibilityFlags: ["nodejs_compat"], mainModule: ${JSON.stringify(MAIN_MODULE)}, modules: bundle.modules, globalOutbound: null });
	return worker.getEntrypoint().fetch("http://tests/", { method: "POST", body: JSON.stringify(bundle.testFiles) });
} };`,
	);
	await writeFile(
		join(dir, "config.capnp"),
		`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
	services = [(name = "host", worker = (
		modules = [(name = "host.js", esModule = embed "host.js"), (name = "bundle.json", json = embed "bundle.json")],
		compatibilityDate = "2026-10-06",
		bindings = [(name = "LOADER", workerLoader = ())],
	))],
	sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "host")],
);`,
	);
	const binary: string = createRequire(import.meta.url)("workerd").default;
	const child = spawn(binary, ["serve", join(dir, "config.capnp"), "--experimental"], { stdio: "ignore" });
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/`);
				if (!res.ok) throw new Error(`host Worker answered ${res.status}: ${await res.text()}`);
				return (await res.json()) as TestReport;
			} catch (error) {
				if (attempt > 100 || (error instanceof Error && error.message.startsWith("host Worker"))) throw error;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	} finally {
		child.kill();
		await rm(dir, { recursive: true, force: true });
	}
}
