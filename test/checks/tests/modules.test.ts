import { describe, expect, it, vi } from "vitest";
import { readLockfile } from "../../../src/checks/tests/lockfile.ts";
import { buildModules, MAIN_MODULE, RUNTIME_MODULE } from "../../../src/checks/tests/modules.ts";

const lockfile = readLockfile(
	new Map([
		[
			"package-lock.json",
			JSON.stringify({
				packages: { "node_modules/esm-pkg": { version: "1.0.0" }, "node_modules/cjs-pkg": { version: "2.0.0" } },
			}),
		],
	]),
);

const PACKAGES: Record<string, Record<string, string>> = {
	"esm-pkg": {
		"package.json": JSON.stringify({ type: "module", exports: { ".": { require: "./index.cjs", import: "./index.js" }, "./sub": "./sub.js" } }),
		"index.js": `import { helper } from "cjs-pkg"; export const greet = () => helper();`,
		"index.cjs": "module.exports = 'wrong entry';",
		"sub.js": "export default 'sub';",
	},
	"cjs-pkg": {
		"package.json": JSON.stringify({ main: "lib/index.js" }),
		"lib/index.js": `const util = require("./util"); exports.helper = () => util.name; Object.defineProperty(exports, "version", { value: 2 }); module.exports.__esModule = true;`,
		"lib/util.js": "module.exports = { name: 'cjs', other: 1 };",
	},
};

const fetchPackage = vi.fn(async ({ name }: { name: string }) => new Map(Object.entries(PACKAGES[name])));

async function build(files: Record<string, string>) {
	return buildModules(new Map(Object.entries(files)), { runtimeSource: "/* runtime */", lockfile, fetchPackage });
}

describe("buildModules", () => {
	it("drops imports only used as types, like TypeScript does", async () => {
		const { modules } = await build({ "test/a.test.ts": `import { T } from "../src/t.ts"; let x: T;` });
		expect(modules["test/a.test.ts"].js).not.toContain("t.ts");
	});

	it("finds test files by convention and adds the runtime", async () => {
		const bundle = await build({
			"test/a.test.ts": "",
			"src/b.spec.mjs": "",
			"src/c.ts": "",
			"node_modules/x/d.test.js": "",
			"dist/e.test.js": "",
		});
		expect(bundle.testFiles).toEqual(["/src/b.spec.mjs", "/test/a.test.ts"]);
		expect(Object.keys(bundle.modules)).toEqual(expect.arrayContaining([MAIN_MODULE, RUNTIME_MODULE, "test/a.test.ts", "src/b.spec.mjs"]));
		expect(bundle.modules).not.toHaveProperty("src/c.ts");
	});

	it("strips types and resolves imports the way bundlers do", async () => {
		const { modules } = await build({
			"test/a.test.ts": [
				`import { expect, it } from "vitest";`,
				`import type { T } from "../src/types.ts";`,
				`import { b } from "../src/b.js";`,
				`import { c } from "../src/c";`,
				`import data from "./data.json";`,
				`import { createHash } from "crypto";`,
				`const lazy = () => import("../src/lazy.ts");`,
				`const x: T = b + c;`,
				`it("uses everything", () => expect([x, data, createHash, lazy]).toBeTruthy());`,
			].join("\n"),
			"src/types.ts": "export type T = string;",
			"src/b.ts": "export const b: string = 'b';",
			"src/c/index.ts": "export const c = 'c';",
			"src/lazy.ts": "export default 1;",
			"test/data.json": '{"ok":true}',
		});
		const test = modules["test/a.test.ts"].js!;
		expect(test).toContain('from "/__qf/vitest.js"');
		expect(test).toContain('from "/src/b.ts"');
		expect(test).toContain('from "/src/c/index.ts"');
		expect(test).toContain('from "/test/data.json"');
		expect(test).toContain('from "node:crypto"');
		expect(test).toContain('import("/src/lazy.ts")');
		expect(test).not.toContain("types.ts");
		expect(test).toContain("const x = b + c;");
		expect(modules["test/data.json"]).toEqual({ json: { ok: true } });
		expect(modules).toHaveProperty("src/lazy.ts");
	});

	it("loads npm packages at their locked versions, with named imports from CommonJS", async () => {
		const { modules, unresolved } = await build({
			"test/a.test.ts": `import { greet } from "esm-pkg"; import sub from "esm-pkg/sub"; import cjs, { helper, version } from "cjs-pkg"; console.log(greet, sub, cjs, helper, version);`,
		});
		expect(unresolved).toEqual([]);
		const test = modules["test/a.test.ts"].js!;
		expect(test).toContain('from "/node_modules/.qf/node_modules_esm-pkg/index.js"');
		expect(test).toContain('from "/node_modules/.qf/node_modules_esm-pkg/sub.js"');
		expect(test).toContain('from "/__qf/cjs/node_modules/.qf/node_modules_cjs-pkg/lib/index.js"');
		expect(modules["node_modules/.qf/node_modules_cjs-pkg/lib/index.js"].cjs).toContain(
			'require("/node_modules/.qf/node_modules_cjs-pkg/lib/util.js")',
		);
		const facade = modules["__qf/cjs/node_modules/.qf/node_modules_cjs-pkg/lib/index.js"].js!;
		expect(facade).toContain("export const { helper, version } = __qf_cjs ?? {};");
		expect(fetchPackage).toHaveBeenCalledTimes(2);
	});

	it("turns unresolvable imports into modules that explain what is missing", async () => {
		const { modules, unresolved } = await build({ "test/a.test.ts": `import "left-pad"; import "./gone";` });
		expect(unresolved).toEqual([
			{ specifier: "left-pad", from: "test/a.test.ts" },
			{ specifier: "./gone", from: "test/a.test.ts" },
		]);
		expect(modules["__qf/missing/left-pad.js"].js).toContain("lockfile");
	});
});
