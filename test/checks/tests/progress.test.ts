import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProgress } from "../../../src/checks/tests/container.ts";

// qf-progress runs inside vitest in a container; the Workers runtime (quality-flare's own Tests check) can't start one.
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const REPORTER = new URL("../../../containers/tests/qf-progress.mjs", import.meta.url).pathname;
const VITEST = new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url).pathname;

describe.skipIf(inWorkers)("qf-progress", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes the tests so far, with the failures, as TestBox reads them", () => {
		dir = mkdtempSync(join(tmpdir(), "qf-progress-"));
		mkdirSync(join(dir, "out"));
		writeFileSync(join(dir, "a.test.js"), 'describe("sum", () => { test("adds", () => {}); test("carries", () => expect(3).toBe(4)); test.skip("later", () => {}); });\n');
		writeFileSync(join(dir, "b.test.js"), 'throw new Error("cannot load");\n');
		spawnSync("node", [VITEST, "run", "--globals", "--reporter", REPORTER], { cwd: dir, env: { ...process.env, OUT: join(dir, "out") }, stdio: "ignore" });
		const progress = parseProgress(readFileSync(join(dir, "out/progress.json"), "utf8"));
		expect(progress).toMatchObject({ files: 2, filesDone: 2, tests: 3, passed: 1, failed: 1, skipped: 1, broken: 1 });
		const failures = [...progress!.failures].sort((a, b) => a.file.localeCompare(b.file));
		expect(failures).toMatchObject([
			{ file: "a.test.js", name: "sum › carries" },
			{ file: "b.test.js", name: "" },
		]);
		expect(failures[0].error).toContain("expected 3 to be 4");
		expect(failures[1].error).toContain("cannot load");
		expect(failures[1].error).not.toContain("node_modules");
	}, 30_000);
});
