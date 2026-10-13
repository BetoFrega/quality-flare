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

	it("maps every Node built-in to its node: module", async () => {
		const { modules, unresolved } = await build({ "test/a.test.ts": `import "http2"; import "v8"; import "fs/promises";` });
		expect(unresolved).toEqual([]);
		expect(modules["test/a.test.ts"].js).toBe(`import "node:http2"; import "node:v8"; import "node:fs/promises";`);
	});

	it("points import.meta.url and dirname under /bundle and env at the runtime, leaving strings and comments alone", async () => {
		const { modules } = await build({
			"test/a.test.ts": `const u = import.meta.url; const d = import.meta .dirname; const s = "import.meta.url"; // import.meta.url\nconst m = import.meta.env.MODE;`,
		});
		expect(modules["test/a.test.ts"].js).toBe(`const u = "file:///bundle/test/a.test.ts"; const d = "/bundle/test"; const s = "import.meta.url"; // import.meta.url\nconst m = globalThis.__qf_import_meta_env.MODE;`);
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
		// Neither imported nor named: left out.
		expect(bundle.modules["src/c.ts"]).toBeUndefined();
	});

	it("carries the repository files that code names, or whose folder it names, for node:fs", async () => {
		const { modules } = await build({
			"test/a.test.ts": `const config = "app.config.yaml"; const all = join(__dirname, "fixtures");`,
			"test/fixtures/one.json.txt": "1",
			"app.config.yaml": "a: 1",
			"docs/notes.md": "# unread",
			"package.json": "{}",
		});
		expect(Object.keys(modules).filter((k) => "text" in modules[k] && !k.startsWith("__qf/"))).toEqual(
			expect.arrayContaining(["test/fixtures/one.json.txt", "app.config.yaml", "package.json"]),
		);
		expect(modules["docs/notes.md"]).toBeUndefined();
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
		expect(modules["test/a.test.js"]).toEqual({ cjs: `__filename = "/bundle/test/a.test.js"; __dirname = "/bundle/test";require("/__qf/process.js"); require("/__qf/process.js");` });
	});

	it("gives vi.mock factories the test file's imports they use and the JSX runtime", async () => {
		const { modules } = await build({
			"test/a.test.tsx": `import { vi } from "vitest";\nimport { spies, other } from "./fixtures";\nimport { unused } from "./unused";\nvi.mock("../src/Box", () => ({ Box: () => <i />, save: spies.save }));`,
			"test/fixtures.ts": "export const spies = {}; export const other = 1;",
			"test/unused.ts": "export const unused = 1;",
		});
		const mocks = modules["test/__qf_mocks__a.test.tsx.js"].js!;
		expect(mocks.split("\n")[0]).toMatch(/^import \{ vi \} from "[^"]+";import \{jsx as _jsx\} from "[^"]+";import \{ spies, \} from "\/test\/fixtures.ts"$/);
	});

	it("moves the vi.fn() declarations a vi.mock factory uses into it", async () => {
		const { modules } = await build({
			"test/a.test.ts": `import { vi } from "vitest";\nconst validate = vi.fn().mockReturnValue(\n  true,\n);\nconst kept = vi.fn();\nvi.mock("../src/v", () => ({ validate: (x: unknown) => validate(x) }));`,
		});
		expect(modules["test/__qf_mocks__a.test.ts.js"].js).toContain("const validate = vi.fn().mockReturnValue(\n  true,\n);");
		expect(modules["test/a.test.ts"].js).toMatch(/^import \{ validate \} from "\/test\/__qf_mocks__a.test.ts.js"; [^\n]*\n\s*\n\s*\nconst kept = vi.fn\(\);/);
	});

	it("gives a package that needs a native binary as a module that fails when used", async () => {
		const { modules } = await build({ "test/a.test.ts": `import sharp from "sharp"; export const s = sharp;` });
		expect(modules["test/a.test.ts"].js).toContain(`from "/__qf/native/sharp.js"`);
		expect(modules["__qf/native/sharp.js"].js).toContain("binário nativo");
	});

	it("assigns a getter defined on module.exports, which workerd ignores", async () => {
		const { modules } = await buildModules(
			new Map([["test/a.test.js", `Object.defineProperty(module, 'exports', { get: f });`]]),
			{ runtimeSource: "", fetchPackage },
		);
		expect(modules["test/a.test.js"].cjs).toContain(`((m, d) => { m.exports = d.get ? d.get() : d.value; })(module, { get: f });`);
	});
});
