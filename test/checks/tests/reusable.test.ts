import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// qf-reusable runs in a container; the Workers runtime (quality-flare's own Tests check) can't spawn it.
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const SCRIPT = new URL("../../../containers/tests/qf-reusable.mjs", import.meta.url).pathname;

describe.skipIf(inWorkers)("qf-reusable", () => {
	let repo: string;
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "qf-reusable-"));
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	function reusable(files: Record<string, unknown>) {
		for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), typeof content === "string" ? content : JSON.stringify(content));
		const run = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });
		return { ok: run.status === 0, why: run.stderr };
	}
	const lock = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } });
	const pinned = { "node_modules/zod": { version: "4.0.0", resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz", integrity: "sha512-x" } };

	it("reuses an npm install whose packages are all pinned by hash or linked to the repository", () => {
		expect(reusable({ "package-lock.json": lock({ ...pinned, "node_modules/ui": { resolved: "packages/ui", link: true }, "packages/ui": { name: "ui" } }) }).ok).toBe(true);
	});

	it("doesn't reuse a package whose contents no hash pins", () => {
		const packed = reusable({ "package-lock.json": lock({ ...pinned, "node_modules/dep": { version: "1.0.0", resolved: "file:vendor/dep" } }) });
		expect(packed).toEqual({ ok: false, why: expect.stringContaining("node_modules/dep") });
		expect(reusable({ "package-lock.json": lock({ "node_modules/a": { resolved: "git+ssh://git@github.com/o/a.git#abc" } }) }).ok).toBe(false);
	});

	it("doesn't reuse without an npm lockfile, or with pnpm or Yarn", () => {
		expect(reusable({ "package.json": {} }).ok).toBe(false);
		expect(reusable({ "package-lock.json": { lockfileVersion: 1, dependencies: {} } }).ok).toBe(false);
		expect(reusable({ "package-lock.json": lock(pinned), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }).ok).toBe(false);
	});
});
