import { parse } from "es-module-lexer/js";
import { exports as packageExports, imports as packageImports } from "resolve.exports";
import { transform } from "sucrase";
import { isLoadable, isPlaywrightSpec, isTestFile } from "./convention.ts";
import type { LockedPackage, Lockfile } from "./lockfile.ts";
import type { PackageFiles } from "./packages.ts";

/** Module names reserved for the test runtime inside the Dynamic Worker. */
export const RUNTIME_MODULE = "__qf/runtime.js";
export const MAIN_MODULE = "__qf/main.js";
const VITEST_MODULE = "__qf/vitest.js";
const PROCESS_MODULE = "__qf/process.js";
/** npm packages are laid out under this folder, one subfolder per locked package. */
const PACKAGES_DIR = "node_modules/.qf";

/**
 * Package.json conditions, in the spirit of the Workers runtime: Node APIs are allowed, and
 * ESM wins over CommonJS whatever order the package lists them in.
 */
const ESM_CONDITIONS = ["workerd", "worker", "import", "module", "node", "default"];
const CJS_CONDITIONS = ["workerd", "worker", "require", "node", "default"];

const NODE_BUILTINS = new Set([
	"assert", "async_hooks", "buffer", "child_process", "console", "constants", "crypto", "diagnostics_channel", "dns",
	"events", "fs", "http", "https", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
	"readline", "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "vm", "worker_threads", "zlib",
]);

export type Modules = Record<string, WorkerLoaderModule>;

export interface TestBundle {
	/** Module paths of the test files, e.g. "/test/a.test.ts", in the order they run. */
	testFiles: string[];
	modules: Modules;
	/** Imports that could not be resolved; the importing file fails when it runs. */
	unresolved: { specifier: string; from: string }[];
}

export interface BuildOptions {
	/** Source of the bundled test runtime (src/checks/tests/runtime). */
	runtimeSource: string;
	/** Exact versions for bare imports; without one, only relative imports and `vitest` resolve. */
	lockfile?: Lockfile;
	/** Downloads a package's files, keyed by their path inside the package. */
	fetchPackage: (pkg: LockedPackage) => Promise<PackageFiles>;
	/** Only these test files (repository paths), for one shard of a run; all of them when omitted. */
	testFiles?: string[];
}

interface Package {
	locked: LockedPackage;
	dir: string;
	files: PackageFiles;
	json: PackageJson;
}

interface PackageJson {
	type?: string;
	main?: string;
	module?: string;
	exports?: unknown;
	imports?: unknown;
}

type Kind = "esm" | "cjs" | "json";

/**
 * Turns a repository's files into the modules of a Dynamic Worker: the test files and
 * everything they import, followed the way Node and bundlers do. TypeScript is stripped,
 * `./a` and `./a.js` find `a.ts`, `vitest` is the bundled runtime, and npm packages come
 * from the registry at the versions in the lockfile.
 */
export async function buildModules(repoFiles: Map<string, string>, options: BuildOptions): Promise<TestBundle> {
	// Playwright specs share the *.spec.ts name but need a browser; they are not ours to run.
	const candidates = options.testFiles?.filter((p) => repoFiles.has(p)) ?? [...repoFiles.keys()];
	const testFiles = candidates.filter((p) => isTestFile(p) && !isPlaywrightSpec(repoFiles.get(p)!)).sort();
	const aliases = tsconfigPaths(repoFiles);
	const modules: Modules = {
		[RUNTIME_MODULE]: { js: options.runtimeSource },
		[VITEST_MODULE]: { js: `export * from "/${RUNTIME_MODULE}";` },
		[PROCESS_MODULE]: { js: `import process from "node:process";\nexport default process;` },
		[MAIN_MODULE]: {
			js: `import { handleRequest } from "/${RUNTIME_MODULE}";
export default { fetch: handleRequest };`,
		},
	};
	const unresolved: TestBundle["unresolved"] = [];
	const packages = new Map<string, Promise<Package | undefined>>();
	const packageByDir = new Map<string, Package>();
	const kinds = new Map<string, Kind>();
	const cjsEdges = new Map<string, Map<string, string>>();
	const facades = new Map<string, string>();

	const packageOf = (name: string) => {
		if (!name.startsWith(`${PACKAGES_DIR}/`)) return undefined;
		const dir = name.slice(0, name.indexOf("/", PACKAGES_DIR.length + 1));
		return packageByDir.get(dir);
	};
	const sourceOf = (name: string) => {
		const pkg = packageOf(name);
		return pkg ? pkg.files.get(name.slice(pkg.dir.length + 1)) : repoFiles.get(name);
	};
	/** Brings a package file into memory; a file that fails to download stays missing. */
	const fetchSource = async (name: string) => {
		const pkg = packageOf(name);
		await pkg?.files.load?.([name.slice(pkg.dir.length + 1)]).catch(() => {});
	};
	const exists = (name: string) => {
		const pkg = packageOf(name);
		return pkg ? pkg.files.has(name.slice(pkg.dir.length + 1)) : repoFiles.has(name) && isLoadable(name);
	};

	const kindOf = (name: string): Kind => {
		let kind = kinds.get(name);
		if (kind) return kind;
		if (name.endsWith(".json")) kind = "json";
		else if (/\.(m?ts|mjs)$/.test(name)) kind = "esm";
		else if (name.endsWith(".cjs")) kind = "cjs";
		else if ((packageOf(name)?.json ?? nearestPackageJson(repoFiles, name)).type === "module") kind = "esm";
		else kind = hasModuleSyntax(sourceOf(name)!) ? "esm" : "cjs";
		kinds.set(name, kind);
		return kind;
	};

	const loadPackage = (locked: LockedPackage) => {
		let pending = packages.get(locked.key);
		if (!pending) {
			pending = options.fetchPackage(locked).then(
				(files) => {
					const dir = `${PACKAGES_DIR}/${locked.key.replace(/[^\w.@-]+/g, "_")}`;
					const pkg: Package = { locked, dir, files, json: JSON.parse(files.get("package.json") ?? "{}") };
					packageByDir.set(dir, pkg);
					return pkg;
				},
				() => undefined,
			);
			packages.set(locked.key, pending);
		}
		return pending;
	};

	/** Resolves an import to a module name, or undefined if it can't be found. */
	const resolve = async (specifier: string, from: string): Promise<string | undefined> => {
		const pkg = packageOf(from);
		const probe = (path: string) => probeFile(path, exists, !pkg, sourceOf);
		if (specifier.startsWith(".")) return probe(join(dirname(from), specifier));
		if (specifier.startsWith("/")) return probe(pkg ? `${pkg.dir}${specifier}` : specifier.slice(1));
		if (specifier.startsWith("#")) {
			const json = pkg?.json ?? rootJson(repoFiles);
			const target = resolveConditions((conditions) => packageImports(json, specifier, { conditions, unsafe: true }));
			if (!target || !target.startsWith("./")) return target ? resolve(target, from) : undefined;
			return probe(join(pkg ? `${pkg.dir}/` : "", target));
		}
		if (!pkg) {
			// tsconfig "paths" come first, as in TypeScript and bundlers.
			for (const path of aliases(specifier, from)) {
				const target = probe(path);
				if (target) return target;
			}
		}
		const [, name, subpath] = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(specifier) ?? [];
		if (!name || !options.lockfile) return undefined;
		const workspace = pkg ? undefined : options.lockfile.workspace(from, name);
		if (workspace !== undefined) {
			// A package of this repository (npm/pnpm workspaces): its files are loaded like the repo's own.
			const json = readJson(repoFiles.get(`${workspace}/package.json`));
			const entry = entryOf(json, subpath);
			return entry ? probe(join(`${workspace}/`, entry)) : undefined;
		}
		const locked = pkg ? options.lockfile.fromPackage(pkg.locked, name) : options.lockfile.fromRepo(from, name);
		const target = locked && (await loadPackage(locked));
		if (!target) return undefined;
		const entry = entryOf(target.json, subpath);
		return entry ? probeFile(join(`${target.dir}/`, entry), exists, false, sourceOf) : undefined;
	};

	/** The replacement for one import, enqueuing the module it points at. */
	const link = async (specifier: string, from: string, importer: Kind): Promise<string> => {
		if (specifier === "vitest") return `/${VITEST_MODULE}`;
		// workerd can't require() node:process from CommonJS, though ESM imports it fine.
		if (importer === "cjs" && (specifier === "process" || specifier === "node:process")) return `/${PROCESS_MODULE}`;
		if (/^(node|cloudflare|workerd):/.test(specifier)) return specifier;
		if (NODE_BUILTINS.has(specifier.split("/")[0])) return `node:${specifier}`;
		const target = await resolve(specifier, from);
		if (!target) {
			unresolved.push({ specifier, from });
			const name = `__qf/missing/${specifier.replace(/[^\w.@-]+/g, "_")}.js`;
			modules[name] = { js: `throw new Error(${JSON.stringify(missingMessage(specifier, from))});` };
			return `/${name}`;
		}
		enqueue(target);
		await fetchSource(target);
		if (importer === "cjs") (cjsEdges.get(from) ?? cjsEdges.set(from, new Map()).get(from)!).set(specifier, target);
		if (importer === "esm" && kindOf(target) === "cjs") {
			const facade = `__qf/cjs/${target}`;
			facades.set(facade, target);
			return `/${facade}`;
		}
		return `/${target}`;
	};

	const seen = new Set<string>();
	let queue: string[] = [];
	const enqueue = (name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			queue.push(name);
		}
	};

	const load = async (name: string) => {
		await fetchSource(name);
		const source = sourceOf(name);
		const kind = kindOf(name);
		if (source === undefined) {
			modules[name] = { js: `throw new Error(${JSON.stringify(`Não foi possível baixar ${name}`)});` };
		} else if (kind === "json") {
			modules[name] = { json: JSON.parse(source) };
		} else if (kind === "cjs") {
			const requires = [...new Set([...source.matchAll(REQUIRE)].map((m) => m[2]))];
			const links = new Map(await Promise.all(requires.map(async (s) => [s, await link(s, name, "cjs")] as const)));
			modules[name] = { cjs: source.replace(REQUIRE, (call, quote, s) => `require(${JSON.stringify(links.get(s))})`) };
		} else {
			const js = /\.m?ts$/.test(name) ? stripTypes(source, name) : source;
			const specifiers = [...new Set(importsOf(js).map((i) => i.n!))];
			const links = new Map(await Promise.all(specifiers.map(async (s) => [s, await link(s, name, "esm")] as const)));
			modules[name] = { js: rewriteImports(js, (s) => links.get(s)!) };
		}
	};

	for (const path of testFiles) enqueue(path);
	// Breadth first, one wave at a time, so packages download in parallel.
	while (queue.length) {
		const wave = queue;
		queue = [];
		await Promise.all(wave.map(load));
	}

	for (const [facade, target] of facades) {
		const names = [...cjsExportNames(target, sourceOf, cjsEdges)].filter(isExportableName);
		modules[facade] = {
			js: `import __qf_cjs from "/${target}";
export default __qf_cjs && __qf_cjs.__esModule && "default" in __qf_cjs ? __qf_cjs.default : __qf_cjs;
${names.length ? `export const { ${names.join(", ")} } = __qf_cjs ?? {};` : ""}`,
		};
	}
	return { testFiles: testFiles.map((p) => `/${p}`), modules, unresolved };
}

/** Bytes of code in a bundle, as the Worker Loader counts them against its size limit (roughly). */
export function bundleSize(bundle: TestBundle): number {
	let size = 0;
	for (const module of Object.values(bundle.modules)) {
		const m = module as { js?: string; cjs?: string; json?: unknown };
		size += (m.js ?? m.cjs ?? JSON.stringify(m.json) ?? "").length;
	}
	return size;
}

const REQUIRE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

function importsOf(source: string) {
	return parse(source)[0].filter((imp) => imp.n !== undefined && imp.d !== -2 && (imp.d === -1 || /^["'`]/.test(source.slice(imp.s, imp.e))));
}

/** `with { type: "json" }` after a static import's closing quote. */
const JSON_ATTRIBUTES = /^(["'])\s*(?:with|assert)\s*\{\s*type\s*:\s*(["'])json\2\s*,?\s*\}/;

/**
 * Replaces every static and literal dynamic import specifier with `map(specifier)`. JSON import
 * attributes are dropped: the Worker Loader rejects them, and `.json` files load as JSON anyway.
 */
function rewriteImports(source: string, map: (specifier: string) => string): string {
	let out = "";
	let last = 0;
	for (const imp of importsOf(source)) {
		const replacement = map(imp.n!);
		out += source.slice(last, imp.s) + (imp.d > -1 ? JSON.stringify(replacement) : replacement);
		last = imp.e;
		const attributes = imp.d === -1 ? JSON_ATTRIBUTES.exec(source.slice(imp.e, imp.e + 64)) : null;
		if (attributes) {
			out += attributes[1];
			last += attributes[0].length;
		}
	}
	return out + source.slice(last);
}

function hasModuleSyntax(source: string): boolean {
	try {
		return parse(source)[3];
	} catch {
		return false;
	}
}

/**
 * Names a CommonJS module exports, found the way Node's cjs-module-lexer does it: by
 * recognizing the shapes compilers emit, and following re-exports.
 */
function cjsExportNames(
	name: string,
	sourceOf: (name: string) => string | undefined,
	edges: Map<string, Map<string, string>>,
	seen = new Set<string>(),
): Set<string> {
	const names = new Set<string>();
	const source = sourceOf(name);
	if (!source || seen.has(name)) return names;
	seen.add(name);
	const add = (regex: RegExp, group: number) => {
		for (const m of source.matchAll(regex)) names.add(m[group]);
	};
	add(/(?:^|[^.\w$])(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g, 1);
	add(/(?:^|[^.\w$])(?:module\.)?exports\[\s*(['"])([^'"]+)\1\s*\]\s*=(?!=)/g, 2);
	add(/Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*(['"])([^'"]+)\1/g, 2);
	// module.exports = { a, b: c, d() {} } and esbuild's __export(target, { a: () => a })
	for (const m of source.matchAll(/(?:module\.exports\s*=\s*|__export\(\s*[\w$]+\s*,\s*)\{([^{}]*)\}/g)) {
		for (const part of m[1].split(",")) {
			const key = /^\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(?::|\(|$)/.exec(part);
			if (key) names.add(key[2] ?? key[3]);
		}
	}
	const reexports = [
		/module\.exports\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)/g,
		/__exportStar\(\s*require\(\s*(['"])([^'"]+)\1/g,
		/__export\(\s*require\(\s*(['"])([^'"]+)\1/g,
	];
	for (const regex of reexports) {
		for (const m of source.matchAll(regex)) {
			const target = edges.get(name)?.get(m[2]);
			if (target) for (const n of cjsExportNames(target, sourceOf, edges, seen)) names.add(n);
		}
	}
	return names;
}

const RESERVED = new Set(
	"default __esModule break case catch class const continue debugger delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval".split(" "),
);
const isExportableName = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name);

/** The specifiers a module imports or requires with a string literal. */
export function importSpecifiers(source: string): string[] {
	const specifiers = new Set([...source.matchAll(REQUIRE)].map((m) => m[2]));
	try {
		for (const imp of importsOf(source)) specifiers.add(imp.n!);
	} catch {
		// Not parseable as ESM: its require() calls are all there is.
	}
	return [...specifiers];
}

/**
 * The file an import loads when it stays inside the importer's package, as the bundle resolves
 * it: a relative import, or one through the package's own name (`next/dist/x` from inside
 * `next`) when the package has no `exports` map, passed as `self`.
 */
export function packageFileOf(
	from: string,
	specifier: string,
	exists: (path: string) => boolean,
	source: (path: string) => string | undefined,
	self?: string,
): string | undefined {
	if (specifier.startsWith(".")) return probeFile(join(dirname(from), specifier), exists, false, source);
	if (self && specifier.startsWith(`${self}/`)) return probeFile(specifier.slice(self.length + 1), exists, false, source);
	return undefined;
}

/** Finds the file an import points at, trying the extensions Node and bundlers try. */
function probeFile(
	path: string,
	exists: (name: string) => boolean,
	typescript: boolean,
	source: (name: string) => string | undefined,
): string | undefined {
	const stem = path.replace(/\.(m?js)$/, "");
	const candidates = [
		path,
		...(typescript ? [`${stem}.ts`, `${stem}.mts`, `${path}.ts`, `${path}/index.ts`] : []),
		`${path}.js`, `${path}.mjs`, `${path}.cjs`, `${path}.json`,
	];
	const file = candidates.find(exists);
	if (file) return file;
	// A folder: its package.json "main" (e.g. next/dist/compiled/*), then its index file, as Node does.
	const main = exists(`${path}/package.json`) ? readJson(source(`${path}/package.json`)).main : undefined;
	const entry = main && probeFile(join(`${path}/`, main), exists, typescript, source);
	return entry || [`${path}/index.js`, `${path}/index.mjs`, `${path}/index.cjs`, `${path}/index.json`].find(exists);
}

/** The file a package import points at, relative to the package: `exports`, else `module`/`main`. */
function entryOf(json: PackageJson, subpath: string | undefined): string | undefined {
	if (json.exports) {
		return resolveConditions((conditions) => packageExports(json, `.${subpath ?? ""}`, { conditions, unsafe: true }));
	}
	return subpath ? `.${subpath}` : (json.module ?? json.main ?? "./index.js");
}

interface TsConfig {
	compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/**
 * The repository's tsconfig `paths` aliases, such as `"@/*": ["./src/*"]`: for an import, the
 * candidate files, from the nearest tsconfig.json above the importer that declares `paths`.
 * `extends` is not followed.
 */
function tsconfigPaths(files: Map<string, string>): (specifier: string, from: string) => string[] {
	const byDir = new Map<string, { base: string; paths: [string, string[]][] } | null>();
	const configFor = (dir: string): { base: string; paths: [string, string[]][] } | null => {
		let config = byDir.get(dir);
		if (config !== undefined) return config;
		const options = (readJson(files.get(`${dir}tsconfig.json`)) as TsConfig).compilerOptions;
		if (options?.paths) {
			config = { base: join(dir, options.baseUrl ?? "."), paths: Object.entries(options.paths) };
		} else {
			config = dir ? configFor(dir.slice(0, dir.lastIndexOf("/", dir.length - 2) + 1)) : null;
		}
		byDir.set(dir, config);
		return config;
	};
	return (specifier, from) => {
		const config = configFor(dirname(from));
		if (!config) return [];
		for (const [pattern, targets] of config.paths) {
			const star = pattern.indexOf("*");
			const [prefix, suffix] = star === -1 ? [pattern, ""] : [pattern.slice(0, star), pattern.slice(star + 1)];
			const matches = star === -1 ? specifier === pattern : specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
			if (!matches) continue;
			const wildcard = star === -1 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length);
			return targets.map((target) => join(config.base ? `${config.base}/` : "", target.replace("*", wildcard)));
		}
		return [];
	};
}

/** Parses package.json or tsconfig.json, which may have comments and trailing commas. */
function readJson(source: string | undefined): PackageJson & TsConfig {
	if (!source) return {};
	try {
		return JSON.parse(source);
	} catch {
		try {
			const stripped = source.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, string) => string ?? "");
			return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			return {};
		}
	}
}

/** The package.json that governs a repository file: the closest one above it. */
function nearestPackageJson(files: Map<string, string>, path: string): PackageJson {
	for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
		const json = files.get(`${path.slice(0, i)}/package.json`);
		if (json) return readJson(json);
	}
	return rootJson(files);
}

function resolveConditions(fn: (conditions: string[]) => string[] | void): string | undefined {
	for (const conditions of [ESM_CONDITIONS, CJS_CONDITIONS]) {
		try {
			const target = fn(conditions)?.[0];
			if (target) return target;
		} catch {
			// Not exported under these conditions.
		}
	}
	return undefined;
}

const rootJsonCache = new WeakMap<Map<string, string>, PackageJson>();
function rootJson(files: Map<string, string>): PackageJson {
	let json = rootJsonCache.get(files);
	if (!json) {
		try {
			json = JSON.parse(files.get("package.json") ?? "{}") as PackageJson;
		} catch {
			json = {};
		}
		rootJsonCache.set(files, json);
	}
	return json;
}

function missingMessage(specifier: string, from: string): string {
	const isPackage = !/^[./#]/.test(specifier);
	return isPackage
		? `"${from}" importa o pacote "${specifier}", que não está no lockfile (pnpm-lock.yaml ou package-lock.json) ou não pôde ser baixado do npm.`
		: `"${from}" importa "${specifier}", que não foi encontrado.`;
}

function stripTypes(source: string, path: string): string {
	return transform(source, { transforms: ["typescript"], disableESTransforms: true, filePath: path }).code;
}

const dirname = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

function join(dir: string, relative: string): string {
	const parts: string[] = [];
	for (const part of `${dir}${relative}`.split("/")) {
		if (part === "..") parts.pop();
		else if (part !== "." && part !== "") parts.push(part);
	}
	return parts.join("/");
}
