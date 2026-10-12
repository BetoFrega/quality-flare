import { describe, expect, it, vi } from "vitest";
import { readLockfile } from "../../../src/checks/tests/lockfile.ts";
import { buildModules } from "../../../src/checks/tests/modules.ts";
import { readPackage } from "../../../src/checks/tests/packages.ts";
import { walkTarball } from "../../../src/checks/tests/tarball.ts";
import { tarball } from "./tar.ts";

const NEXT = {
	"package.json": JSON.stringify({ name: "next", main: "./index.js" }),
	"dist/a.js": `exports.a = require("./b").b + require("next/dist/c").c;`,
	"index.js": `module.exports = require("./dist/a");`,
	"dist/b.js": "exports.b = require('./compiled/d').d;",
	// A folder import loads its package.json "main", as in next/dist/compiled/*.
	"dist/compiled/d/lib/d.js": "exports.d = 'd';",
	"dist/compiled/d/package.json": JSON.stringify({ main: "lib/d.js" }),
	"dist/c.js": "exports.c = 'c';",
	"dist/unused.js": "exports.unused = true;",
	"README.md": "# next",
};

const isPackageFile = (path: string) => /\.(c|m)?js$|\.json$/.test(path);

/** A package download that counts how often it ran. */
function registry(files: Record<string, string>) {
	const download = vi.fn(async () => tarball(files, "package"));
	return download;
}

describe("walkTarball", () => {
	it("reads files spanning many stream chunks, skipping the ones not asked for", async () => {
		const big = "x".repeat(300_000);
		const seen: string[] = [];
		const kept = new Map<string, string>();
		await walkTarball(tarball({ "skip.bin": "y".repeat(200_000), "big.js": big, "small.js": "1" }), (path) => {
			seen.push(path);
			return path.endsWith(".js") ? (text) => kept.set(path, text) : undefined;
		});
		expect(seen).toEqual(["skip.bin", "big.js", "small.js"]);
		expect(kept.get("big.js")).toBe(big);
		expect(kept.get("small.js")).toBe("1");
	});

	it("stops once it has what it needs", async () => {
		const seen: string[] = [];
		await walkTarball(
			tarball({ "a.js": "", "b.js": "", "c.js": "" }),
			(path) => (seen.push(path), undefined),
			() => seen.length === 2,
		);
		expect(seen).toEqual(["a.js", "b.js"]);
	});
});

describe("readPackage", () => {
	it("keeps a small package whole after one download", async () => {
		const download = registry(NEXT);
		const files = await readPackage(download, isPackageFile);
		expect(files.load).toBeUndefined();
		expect(files.get("dist/unused.js")).toBe(NEXT["dist/unused.js"]);
		expect(files.has("README.md")).toBe(false);
		expect(download).toHaveBeenCalledTimes(1);
	});

	it("reads a package over the budget on demand, with what it imports inside the package, in one more download", async () => {
		const download = registry(NEXT);
		const files = await readPackage(download, isPackageFile, 10);
		expect(files.get("package.json")).toBe(NEXT["package.json"]);
		expect(files.has("dist/a.js")).toBe(true);
		expect(files.get("dist/a.js")).toBeUndefined();

		await files.load!(["index.js"]);
		expect(files.get("index.js")).toBe(NEXT["index.js"]);
		// "./dist/a" from index.js, then "./b" and "next/dist/c" from dist/a.js, though dist/a.js comes first.
		expect(files.get("dist/a.js")).toBe(NEXT["dist/a.js"]);
		expect(files.get("dist/b.js")).toBe(NEXT["dist/b.js"]);
		expect(files.get("dist/c.js")).toBe(NEXT["dist/c.js"]);
		expect(files.get("dist/compiled/d/lib/d.js")).toBe(NEXT["dist/compiled/d/lib/d.js"]);
		expect(files.get("dist/unused.js")).toBeUndefined();
		expect(download).toHaveBeenCalledTimes(2);

		await files.load!(["dist/b.js"]);
		expect(download).toHaveBeenCalledTimes(2);
	});

	it("gathers the requests of one moment into one download", async () => {
		const download = registry(NEXT);
		const files = await readPackage(download, isPackageFile, 10);
		await Promise.all([files.load!(["dist/b.js"]), files.load!(["dist/unused.js"])]);
		expect(files.get("dist/unused.js")).toBe(NEXT["dist/unused.js"]);
		expect(download).toHaveBeenCalledTimes(2);
	});
});

describe("buildModules with a package read on demand", () => {
	it("bundles the same modules as with the whole package in memory", async () => {
		const lockfile = readLockfile(new Map([["package-lock.json", JSON.stringify({ packages: { "node_modules/next": { version: "16.0.0" } } })]]));
		const build = (budget: number) =>
			buildModules(new Map([["test/a.test.ts", `import { a } from "next"; export default a;`]]), {
				runtimeSource: "",
				lockfile,
				fetchPackage: () => readPackage(registry(NEXT), isPackageFile, budget),
			});
		const [whole, onDemand] = await Promise.all([build(Infinity), build(10)]);
		expect(onDemand.unresolved).toEqual([]);
		expect(Object.keys(onDemand.modules).filter((name) => name.endsWith("dist/compiled/d/lib/d.js"))).toHaveLength(1);
		expect(onDemand.modules).toEqual(whole.modules);
		expect(Object.keys(onDemand.modules).filter((name) => name.endsWith("dist/c.js"))).toHaveLength(1);
	});
});
