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
		"compiled/parser/package.json": JSON.stringify({ main: "parser.js" }),
		"compiled/parser/parser.js": "module.exports = { parse: () => 'parsed' };",
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

	it("loads a folder through its package.json main, as Node does", async () => {
		const { modules, unresolved } = await build({ "test/a.test.ts": `import { parse } from "cjs-pkg/compiled/parser"; console.log(parse);` });
		expect(unresolved).toEqual([]);
		expect(modules["test/a.test.ts"].js).toContain("node_modules_cjs-pkg/compiled/parser/parser.js");
	});

	it("turns unresolvable imports into modules that explain what is missing", async () => {
		const { modules, unresolved } = await build({ "test/a.test.ts": `import "left-pad"; import "./gone";` });
		expect(unresolved).toEqual([
			{ specifier: "left-pad", from: "test/a.test.ts" },
			{ specifier: "./gone", from: "test/a.test.ts" },
		]);
		expect(modules["__qf/missing/left-pad.js"].js).toContain("lockfile");
	});

	it("follows tsconfig paths and workspace packages", async () => {
		const files = {
			"package-lock.json": JSON.stringify({
				packages: { "node_modules/@app/shared": { resolved: "packages/shared", link: true } },
			}),
			"tsconfig.json": `{
				// comments and trailing commas, as tsc allows
				"compilerOptions": { "paths": { "@/*": ["./src/*"], "~config": ["./config/index.ts"], }, },
			}`,
			"packages/shared/package.json": JSON.stringify({ exports: { ".": "./index.ts", "./util": "./util.ts" } }),
			"packages/shared/index.ts": "export const shared = 1;",
			"packages/shared/util.ts": `import { a } from "@/a"; export const util = a;`,
			"packages/shared/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
			"packages/shared/a.ts": "export const a = 'shared';",
			"src/a.ts": "export const a = 'root';",
			"config/index.ts": "export default {};",
			"test/a.test.ts": `import { a } from "@/a"; import config from "~config"; import { shared } from "@app/shared"; import { util } from "@app/shared/util"; console.log(a, config, shared, util);`,
		};
		const { modules, unresolved } = await buildModules(new Map(Object.entries(files)), {
			runtimeSource: "",
			lockfile: readLockfile(new Map(Object.entries(files))),
			fetchPackage,
		});
		expect(unresolved).toEqual([]);
		const test = modules["test/a.test.ts"].js!;
		expect(test).toContain('from "/src/a.ts"');
		expect(test).toContain('from "/config/index.ts"');
		expect(test).toContain('from "/packages/shared/index.ts"');
		expect(test).toContain('from "/packages/shared/util.ts"');
		// Inside the workspace package, its own tsconfig wins.
		expect(modules["packages/shared/util.ts"].js).toContain('from "/packages/shared/a.ts"');
	});

	it("leaves Playwright specs out", async () => {
		const { testFiles } = await build({
			"e2e/home.spec.ts": `import { test } from "@playwright/test";`,
			"test/a.test.ts": "",
		});
		expect(testFiles).toEqual(["/test/a.test.ts"]);
	});

	it("drops JSON import attributes, which the Worker Loader rejects", async () => {
		const { modules } = await build({
			"test/a.test.ts": `import data from "./data.json" with { type: "json" }; import other from './other.json' assert { type: 'json' }; console.log(data, other);`,
			"test/data.json": "{}",
			"test/other.json": "{}",
		});
		expect(modules["test/a.test.ts"].js).toContain(`import data from "/test/data.json"; import other from '/test/other.json';`);
	});

	it("gives CommonJS node:process through an ESM module, as workerd can't require it", async () => {
		const { modules } = await buildModules(
			new Map([["test/a.test.js", `require("process"); require("node:process");`]]),
			{ runtimeSource: "", fetchPackage },
		);
		expect(modules["test/a.test.js"]).toEqual({ cjs: `require("/__qf/process.js"); require("/__qf/process.js");` });
	});
});
