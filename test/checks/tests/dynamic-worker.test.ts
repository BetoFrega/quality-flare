import { describe, expect, it } from "vitest";
import { readLockfile } from "../../../src/checks/tests/lockfile.ts";
import { buildModules, MAIN_MODULE, type TestBundle } from "../../../src/checks/tests/modules.ts";
import type { ProgressEvent, RunRequest, TestReport } from "../../../src/checks/tests/report.ts";
import { readRun } from "../../../src/checks/tests/stream.ts";
import { serveWorkerd } from "../../workerd.ts";

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
		const progress: ProgressEvent[] = [];
		const report = await runInWorkerd(bundle, (event) => progress.push(event));

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

		// Each test is streamed as it finishes, with the same name the report uses.
		expect(progress[0]).toEqual({ type: "collected", total: 8 });
		expect(progress).toContainEqual(expect.objectContaining({ type: "test", file: "test/math.test.ts", name: "add › adds", state: "pass" }));
		expect(progress).toContainEqual(expect.objectContaining({ type: "test", file: "test/fail.test.ts", name: "fails an assertion", state: "fail" }));
	}, 30_000);

	it("runs setup files first and exposes globals, as quality-flare.json asks", async () => {
		const { default: runtimeSource } = await import("virtual:test-runtime");
		const repo = {
			"setup.ts": "(globalThis as any).ready = 'set up';",
			"test/globals.test.ts": "it('sees setup and globals', () => { expect((globalThis as any).ready).toBe('set up'); expect(typeof vi.fn).toBe('function'); });",
		};
		const bundle = await buildModules(new Map(Object.entries(repo)), {
			runtimeSource,
			fetchPackage: () => Promise.reject(new Error("offline")),
			setupFiles: ["./setup.ts"],
		});
		const report = await runInWorkerd(bundle, () => {}, { globals: true });
		expect(report.files.map((f) => [f.path, f.state, f.errors])).toEqual([["test/globals.test.ts", "pass", undefined]]);
	}, 30_000);

	it("mocks modules per test file with vi.mock, vi.hoisted and importOriginal", async () => {
		const { default: runtimeSource } = await import("virtual:test-runtime");
		const repo = {
			"src/clock.ts": "export const now = (): string => 'real now'; export const zone = 'America/Sao_Paulo';",
			"src/greet.ts": `import { now } from "./clock"; export const greet = (name: string) => \`\${name} at \${now()}\`;`,
			// A module that throws on import: mocking it keeps it from loading.
			"src/firebase.ts": "throw new Error('firebase must not load'); export const db = 1;",
			"src/uses-firebase.ts": "import { db } from './firebase'; export const read = () => db;",
			"test/a.test.ts": `
				import { expect, it, vi } from "vitest";
				import { greet } from "../src/greet";
				const { fake } = vi.hoisted(() => ({ fake: vi.fn(() => "mocked now") }));
				vi.mock("../src/clock", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/clock")>()), now: fake }));
				it("sees the mock through another module", () => {
					expect(greet("Ana")).toBe("Ana at mocked now");
					expect(fake).toHaveBeenCalledOnce();
				});
				it("keeps what importOriginal brought", async () => {
					const { zone } = await import("../src/clock");
					expect(zone).toBe("America/Sao_Paulo");
					expect((await vi.importActual<typeof import("../src/clock")>("../src/clock")).now()).toBe("real now");
				});`,
			"test/b.test.ts": `
				import { expect, it } from "vitest";
				import { greet } from "../src/greet";
				it("sees the real module", () => expect(greet("Bia")).toBe("Bia at real now"));`,
			"test/c.test.ts": `
				import { expect, it, vi } from "vitest";
				import { read } from "../src/uses-firebase";
				vi.mock("../src/firebase", () => ({ db: "fake db" }));
				vi.mock("server-only", () => ({}));
				it("never loads the mocked module", () => expect(read()).toBe("fake db"));`,
			"docs/a.md": "# A",
			"src/mode.ts": "export const mode = process.env.MODE;",
			"test/e.test.ts": `
				import { expect, it, vi } from "vitest";
				it("evaluates modules again after vi.resetModules", async () => {
					vi.stubEnv("MODE", "a");
					const a = await import("../src/mode");
					vi.resetModules();
					vi.stubEnv("MODE", "b");
					const b = await import("../src/mode");
					expect([a.mode, b.mode]).toEqual(["a", "b"]);
					vi.unstubAllEnvs();
				});`,
			"test/d.test.ts": `
				import { expect, it, vi } from "vitest";
				it("stubs env and waits", async () => {
					vi.stubEnv("MODE", "test");
					expect(process.env.MODE).toBe("test");
					vi.unstubAllEnvs();
					expect(process.env.MODE).toBeUndefined();
					let n = 0;
					expect(await vi.waitFor(() => { if (++n < 3) throw new Error("not yet"); return n; }, { interval: 1 })).toBe(3);
				});
				it("reads repository files from the working directory", async () => {
					const { readFileSync } = await import("node:fs");
					const { resolve } = await import("node:path");
					expect(resolve("docs/a.md")).toBe("/bundle/docs/a.md");
					expect(readFileSync(resolve("docs/a.md"), "utf8")).toBe("# A");
				});
				it("fakes timers and the clock", async () => {
					vi.useFakeTimers();
					vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
					let fired = false;
					setTimeout(() => { fired = true; }, 1000);
					expect(vi.getTimerCount()).toBe(1);
					await vi.advanceTimersByTimeAsync(1000);
					expect(fired).toBe(true);
					expect(new Date().toISOString()).toBe("2026-01-01T00:00:01.000Z");
					vi.useRealTimers();
				});`,
		};
		const bundle = await buildModules(new Map(Object.entries(repo)), {
			runtimeSource,
			fetchPackage: () => Promise.reject(new Error("offline")),
		});
		expect(bundle.unresolved).toEqual([]);
		const report = await runInWorkerd(bundle, () => {});
		expect(report.files.map((f) => [f.path, f.state, f.errors, f.tests.map((t) => [t.name, t.state, t.errors])])).toEqual([
			["test/a.test.ts", "pass", undefined, [["sees the mock through another module", "pass", undefined], ["keeps what importOriginal brought", "pass", undefined]]],
			["test/b.test.ts", "pass", undefined, [["sees the real module", "pass", undefined]]],
			["test/c.test.ts", "pass", undefined, [["never loads the mocked module", "pass", undefined]]],
			["test/d.test.ts", "pass", undefined, [["stubs env and waits", "pass", undefined], ["reads repository files from the working directory", "pass", undefined], ["fakes timers and the clock", "pass", undefined]]],
			["test/e.test.ts", "pass", undefined, [["evaluates modules again after vi.resetModules", "pass", undefined]]],
		]);
	}, 30_000);

	it("shares packages between files as vitest would load them per file", async () => {
		const { default: runtimeSource } = await import("virtual:test-runtime");
		const lockfile = readLockfile(
			new Map([["package-lock.json", JSON.stringify({ packages: { "node_modules/cleanup": { version: "1.0.0" }, "node_modules/styles": { version: "1.0.0" } } })]]),
		);
		const packages: Record<string, Record<string, string>> = {
			// Like @testing-library/react: registers a hook as it is imported.
			cleanup: {
				"package.json": JSON.stringify({ main: "index.js" }),
				"index.js": "const mounted = []; afterEach(() => { mounted.length = 0; }); exports.mount = (x) => { mounted.push(x); return mounted.length; };",
			},
			// Like ansi-styles: module.exports through a getter.
			styles: { "package.json": JSON.stringify({ main: "index.js" }), "index.js": "Object.defineProperty(module, 'exports', { get: () => ({ gray: 'g' }) });" },
		};
		const mountTwice = (name: string) => `
				import { expect, it } from "vitest";
				import { mount } from "cleanup";
				import styles from "styles";
				it("${name} mounts", () => expect(mount(1)).toBe(1));
				it("${name} is cleaned up", () => expect([mount(2), styles.gray]).toEqual([1, "g"]));`;
		const repo = {
			"src/broken.ts": "throw new Error('cannot load here'); export const value = 1;",
			"test/a.test.ts": mountTwice("a"),
			"test/b.test.ts": mountTwice("b"),
			"test/c.test.ts": `
				import { expect, it } from "vitest";
				import { value } from "../src/broken";
				it("fails only where the module is used", () => expect(() => value + 1).toThrow("cannot load here"));`,
			"test/d.test.ts": `
				import { expect, it, vi } from "vitest";
				import { value } from "../src/broken";
				vi.mock("../src/broken", () => ({ value: 2 }));
				it("mocks it", () => expect(value).toBe(2));`,
		};
		const bundle = await buildModules(new Map(Object.entries(repo)), {
			runtimeSource,
			lockfile,
			fetchPackage: async ({ name }) => new Map(Object.entries(packages[name])),
		});
		const report = await runInWorkerd(bundle, () => {}, { globals: true });
		expect(report.files.map((f) => [f.path, f.state, f.errors ?? f.tests.flatMap((t) => t.errors ?? [])])).toEqual([
			["test/a.test.ts", "pass", []],
			["test/b.test.ts", "pass", []],
			["test/c.test.ts", "pass", []],
			["test/d.test.ts", "pass", []],
		]);
	}, 30_000);

	it("imports modules that generate code or draw random values as they load", async () => {
		const { default: runtimeSource } = await import("virtual:test-runtime");
		const repo = {
			// Like protobufjs, loaded by firebase-admin: compiles functions it calls only when encoding.
			"src/load.ts": `
				import { randomBytes } from "node:crypto";
				export const encode = Function("prefix", "return function encode(x) { return prefix + x; }")("p");
				export const id = crypto.randomUUID();
				export const bytes = randomBytes(4).length;`,
			"test/load.test.ts": `
				import { expect, it } from "vitest";
				import { bytes, encode, id } from "../src/load";
				it("loads, and fails only where generated code runs", () => {
					expect([id, bytes]).toEqual([expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/), 4]);
					expect(() => encode(1)).toThrow(EvalError);
					expect(() => Function("return 1")).toThrow(EvalError);
				});`,
		};
		const bundle = await buildModules(new Map(Object.entries(repo)), { runtimeSource, fetchPackage: () => Promise.reject(new Error("offline")) });
		const report = await runInWorkerd(bundle, () => {});
		expect(report.files.map((f) => [f.path, f.state, f.errors ?? f.tests.flatMap((t) => t.errors ?? [])])).toEqual([["test/load.test.ts", "pass", []]]);
	}, 30_000);
});

/** Serves a host Worker with a Worker Loader binding on workerd and has it run the bundle. */
async function runInWorkerd(
	bundle: TestBundle,
	onProgress: (event: ProgressEvent) => void,
	options: Omit<RunRequest, "files" | "setupFiles"> = {},
): Promise<TestReport> {
	const run: RunRequest = { files: bundle.testFiles, setupFiles: bundle.setupFiles, ...options };
	const host = `import bundle from "bundle.json";
export default { async fetch(request, env) {
	if (new URL(request.url).pathname !== "/") return new Response("up");
	const worker = env.LOADER.load({ compatibilityDate: "2026-10-06", compatibilityFlags: ["nodejs_compat"], mainModule: ${JSON.stringify(MAIN_MODULE)}, modules: bundle.modules, globalOutbound: null });
	return worker.getEntrypoint().fetch("http://tests/", { method: "POST", body: JSON.stringify(bundle.run) });
} };`;
	const server = await serveWorkerd({ "host.js": host, "bundle.json": JSON.stringify({ modules: bundle.modules, run }) }, `bindings = [(name = "LOADER", workerLoader = ())],`);
	try {
		const res = await fetch(`${server.url}/`);
		if (!res.ok) throw new Error(`host Worker answered ${res.status}: ${await res.text()}`);
		return await readRun(res, onProgress);
	} finally {
		await server.stop();
	}
}
