import { parse } from "es-module-lexer/js";
import { exports as packageExports, imports as packageImports } from "resolve.exports";
import { transform } from "sucrase";
import { isLoadable, isPlaywrightSpec, isTestFile } from "./convention.ts";
import type { LockedPackage, Lockfile } from "./lockfile.ts";
import { ACTUAL, rewriteImportActual, splitMocks } from "./mocks.ts";
import type { PackageFiles } from "./packages.ts";

/** Module names reserved for the test runtime inside the Dynamic Worker. */
export const RUNTIME_MODULE = "__qf/runtime.js";
export const MAIN_MODULE = "__qf/main.js";
const VITEST_MODULE = "__qf/vitest.js";
const PROCESS_MODULE = "__qf/process.js";
const EMPTY_MODULE = "__qf/empty.js";
const RESET_MODULES = /\bvi\s*\.\s*resetModules\s*\(/;
/** Fresh copies per module for files that call vi.resetModules(): resets past the last reuse it. */
const FRESH_COPIES = 3;
/**
 * workerd's path.resolve() and relative() resolve against "/", not process.cwd() ("/bundle"),
 * so `resolve("docs")` misses the repository. This node:path resolves against the cwd.
 */
const PATH_MODULE = "__qf/path.js";
const PATH_SHIM = `import path from "node:path";
import process from "node:process";
export const resolve = (...paths) => path.posix.resolve(process.cwd(), ...paths);
export const relative = (from, to) => path.posix.relative(resolve(from), resolve(to));
export const { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, sep, toNamespacedPath, win32, matchesGlob } = path;
export const posix = { ...path.posix, resolve, relative };
posix.posix = posix;
export default posix;`;
const CSS_MODULE = "__qf/css-module.js";
const ASSET_IMPORT = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|pdf|txt)(\?.*)?$/;
const STYLESHEET = /\.(css|scss|sass|less|styl|stylus|pcss|postcss)(\?.*)?$/;
/** Each test file's mocks, environment and setup copies; read by runtime/mocks.ts. */
const FILES_MODULE = "__qf/files.js";
/** vitest environments and the package each needs; read by runtime/environment.ts. */
const ENVIRONMENT_PACKAGES: Record<string, string> = { jsdom: "jsdom", "happy-dom": "happy-dom" };
const ENVIRONMENT_COMMENT = /^\s*(?:\/\/|\/?\*+)\s*@vitest-environment\s+([\w-]+)/m;
/** npm packages are laid out under this folder, one subfolder per locked package. */
const PACKAGES_DIR = "node_modules/.qf";

/**
 * Package.json conditions, in the spirit of the Workers runtime: Node APIs are allowed, and
 * ESM wins over CommonJS whatever order the package lists them in.
 */
const ESM_CONDITIONS = ["workerd", "worker", "import", "module", "node", "default"];
const CJS_CONDITIONS = ["workerd", "worker", "require", "node", "default"];

const NODE_BUILTINS = new Set([
	"assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
	"diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os",
	"path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
	"timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

export type Modules = Record<string, WorkerLoaderModule>;

export interface Unresolved {
	specifier: string;
	from: string;
	/** Why, when the package was found in the lockfile but couldn't be downloaded. */
	reason?: string;
}

export interface TestBundle {
	/** Module paths of the test files, e.g. "/test/a.test.ts", in the order they run. */
	testFiles: string[];
	/** Module paths of the setup files, run before each test file. */
	setupFiles: string[];
	modules: Modules;
	/** Imports that could not be resolved; the importing file fails when it runs. */
	unresolved: Unresolved[];
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
	/** Repository paths of files to run before each test file (vitest's `setupFiles`). */
	setupFiles?: string[];
	/** vitest's `environment` for files without a `@vitest-environment` comment; "node" by default. */
	environment?: string;
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

interface EsmModule {
	js: string;
	/** Specifier → the module name it links to. */
	links: Map<string, string>;
	/** Specifier → the names its static imports and re-exports take from it. */
	names: Map<string, string[]>;
	/** Links to mocked modules reach the real ones (a test file's hoisted `vi.mock` module). */
	real: boolean;
}

/**
 * Turns a repository's files into the modules of a Dynamic Worker: the test files and
 * everything they import, followed the way Node and bundlers do. TypeScript is stripped,
 * `./a` and `./a.js` find `a.ts`, `vitest` is the bundled runtime, and npm packages come
 * from the registry at the versions in the lockfile.
 */
export async function buildModules(repoFiles: Map<string, string>, options: BuildOptions): Promise<TestBundle> {
	// Playwright specs share the *.spec.ts name but need a browser; they are not ours to run.
	// Given test files were already picked (by convention or quality-flare.json); otherwise, by convention.
	const candidates = options.testFiles?.filter((p) => repoFiles.has(p)) ?? [...repoFiles.keys()].filter(isTestFile);
	const testFiles = candidates.filter((p) => !isPlaywrightSpec(repoFiles.get(p)!)).sort();
	const setupFiles = (options.setupFiles ?? []).map((p) => p.replace(/^\.?\//, ""));
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
	const packages = new Map<string, Promise<Package | DownloadFailed>>();
	const packageByDir = new Map<string, Package>();
	const kinds = new Map<string, Kind>();
	const cjsEdges = new Map<string, Map<string, string>>();
	const facades = new Map<string, string>();
	const tests = new Set(testFiles);
	// ESM modules are emitted last: imports of a mocked module go to its facade, known once all are loaded.
	const esm = new Map<string, EsmModule>();
	const realOnly = new Set<string>();
	const mockKeys = new Set<string>();
	const mocksOf = new Map<string, { module: string; keys: Set<string>; original: boolean }>();
	const missingNames = new Map<Unresolved, string>();
	const environments = new Map<string, string>();

	const packageOf = (name: string) => {
		if (!name.startsWith(`${PACKAGES_DIR}/`)) return undefined;
		const dir = name.slice(0, name.indexOf("/", PACKAGES_DIR.length + 1));
		return packageByDir.get(dir);
	};
	const sourceOf = (name: string) => {
		const pkg = packageOf(name);
		const source = pkg ? pkg.files.get(name.slice(pkg.dir.length + 1)) : repoFiles.get(name);
		// A hashbang line (`#!/usr/bin/env node`) becomes a comment: neither parser accepts it.
		return source?.startsWith("#!") ? `//${source.slice(2)}` : source;
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

	/** The "type" of the package.json closest above a file, as Node reads it (dist/commonjs/package.json included). */
	const nearestType = (name: string): string | undefined => {
		const pkg = packageOf(name);
		if (!pkg) return nearestPackageJson(repoFiles, name).type;
		for (let i = name.lastIndexOf("/"); i > pkg.dir.length; i = name.lastIndexOf("/", i - 1)) {
			const json = pkg.files.get(`${name.slice(pkg.dir.length + 1, i)}/package.json`);
			if (json) return readJson(json).type;
		}
		return pkg.json.type;
	};

	const kindOf = (name: string): Kind => {
		let kind = kinds.get(name);
		if (kind) return kind;
		if (name.endsWith(".json")) kind = "json";
		else if (/\.(m?ts|mjs|[jt]sx)$/.test(name)) kind = "esm";
		else if (name.endsWith(".cjs")) kind = "cjs";
		else if (nearestType(name) === "module") kind = "esm";
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
				(error: unknown) => new DownloadFailed(locked, error),
			);
			packages.set(locked.key, pending);
		}
		return pending;
	};

	/** Resolves an import to a module name, or undefined if it can't be found. */
	const resolve = async (specifier: string, from: string, importer: Kind): Promise<string | undefined> => {
		const pkg = packageOf(from);
		const probe = (path: string) => probeFile(path, exists, !pkg, sourceOf);
		if (specifier.startsWith(".")) return probe(join(dirname(from), specifier));
		if (specifier.startsWith("/")) return probe(pkg ? `${pkg.dir}${specifier}` : specifier.slice(1));
		if (specifier.startsWith("#")) {
			const json = pkg?.json ?? rootJson(repoFiles);
			const target = resolveConditions((conditions) => packageImports(json, specifier, { conditions, unsafe: true }), importer);
			if (!target || !target.startsWith("./")) return target ? resolve(target, from, importer) : undefined;
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
			const entry = entryOf(json, subpath, importer);
			return entry ? probe(join(`${workspace}/`, entry)) : undefined;
		}
		const locked = pkg ? options.lockfile.fromPackage(pkg.locked, name) : options.lockfile.fromRepo(from, name);
		const target = locked && (await loadPackage(locked));
		if (!target) return undefined;
		if (target instanceof DownloadFailed) throw target;
		const entry = entryOf(target.json, subpath, importer);
		return entry ? probeFile(join(`${target.dir}/`, entry), exists, false, sourceOf) : undefined;
	};

	/** The replacement for one import, enqueuing the module it points at. */
	const link = async (specifier: string, from: string, importer: Kind): Promise<string> => {
		if (specifier === "vitest") return `/${VITEST_MODULE}`;
		// workerd can't require() node:process from CommonJS, though ESM imports it fine.
		if (importer === "cjs" && (specifier === "process" || specifier === "node:process")) return `/${PROCESS_MODULE}`;
		if (/^(node:)?path(\/posix)?$/.test(specifier)) {
			modules[PATH_MODULE] ??= { js: PATH_SHIM };
			return `/${PATH_MODULE}`;
		}
		if (/^(node|cloudflare|workerd):/.test(specifier)) return specifier;
		if (NODE_BUILTINS.has(specifier.split("/")[0])) return `node:${specifier}`;
		// As Vite: importing an image, font or media file gives its URL.
		if (ASSET_IMPORT.test(specifier)) {
			const module = `__qf/asset/${specifier.replace(/[^\w./@-]+/g, "_")}.js`;
			modules[module] ??= { js: `export default ${JSON.stringify(`/${specifier.replace(/^(\.\.?\/)+/, "").replace(/\?.*$/, "")}`)};` };
			return `/${module}`;
		}
		// As vitest without `css.include`: stylesheets are empty, CSS modules map each class to its name.
		if (STYLESHEET.test(specifier)) {
			const module = /\.module\.[a-z]+$/.test(specifier) ? CSS_MODULE : EMPTY_MODULE;
			modules[module] ??= { js: module === CSS_MODULE ? `export default new Proxy({}, { get: (_, key) => (typeof key === "string" ? key : undefined) });` : "export {};" };
			return `/${module}`;
		}
		const target = await resolve(specifier, from, importer).catch((error: unknown) => {
			if (error instanceof DownloadFailed) return error;
			throw error;
		});
		if (!target || target instanceof DownloadFailed) {
			const reason = target instanceof DownloadFailed ? target.message : undefined;
			const entry = reason ? { specifier, from, reason } : { specifier, from };
			unresolved.push(entry);
			const name = `__qf/missing/${specifier.replace(/[^\w.@-]+/g, "_")}.js`;
			missingNames.set(entry, `/${name}`);
			modules[name] = { js: `throw new Error(${JSON.stringify(reason ? `"${from}" importa "${specifier}": ${reason}` : missingMessage(specifier, from))});` };
			return `/${name}`;
		}
		enqueue(target);
		await fetchSource(target);
		if (importer === "cjs") (cjsEdges.get(from) ?? cjsEdges.set(from, new Map()).get(from)!).set(specifier, target);
		// workerd's require() of an ES module returns its default export; Node's, its namespace.
		if (importer === "cjs" && kindOf(target) === "esm") {
			const shim = `__qf/esm/${target}`;
			modules[shim] = { js: `import * as __qf_ns from "/${target}";\nexport default __qf_ns;` };
			return `/${shim}`;
		}
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

	/** A module that can't be parsed fails when imported, not the whole bundle. */
	const load = (name: string) =>
		loadModule(name).catch((error: unknown) => {
			const message = `quality-flare não conseguiu ler "${name}": ${error instanceof Error ? error.message : String(error)}`;
			modules[name] = { js: `throw new Error(${JSON.stringify(message)});` };
		});

	const loadModule = async (name: string) => {
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
			// workerd's require has no resolve(): literal ones become the file's path under /bundle.
			const resolves = [...new Set([...source.matchAll(REQUIRE_RESOLVE)].map((m) => m[2]))];
			const resolved = new Map(
				await Promise.all(resolves.map(async (s) => [s, await resolve(s, name, "cjs").catch(() => undefined)] as const)),
			);
			const cjs = source
				.replace(REQUIRE, (call, quote, s) => `require(${JSON.stringify(links.get(s))})`)
				.replace(REQUIRE_RESOLVE, (call, quote, s: string) => {
					const target = resolved.get(s);
					return target ? JSON.stringify(`${BUNDLE_ROOT}/${target}`) : `(() => { throw new Error(${JSON.stringify(`Cannot find module '${s}'`)}); })()`;
				});
			// After a "use strict" directive, which must stay first; on its line, so line numbers hold.
			const directive = /^\s*(['"])use strict\1;?/.exec(cjs)?.[0] ?? "";
			const filename = `${BUNDLE_ROOT}/${name}`;
			const paths = `__filename = ${JSON.stringify(filename)}; __dirname = ${JSON.stringify(filename.slice(0, filename.lastIndexOf("/")))};`;
			const separator = directive && !directive.endsWith(";") ? ";" : "";
			modules[name] = { cjs: `${directive}${separator}${paths}${cjs.slice(directive.length)}` };
		} else {
			if (tests.has(name)) {
				const environment = ENVIRONMENT_COMMENT.exec(source)?.[1] ?? options.environment;
				const pkg = environment && ENVIRONMENT_PACKAGES[environment];
				if (environment && environment !== "node") environments.set(name, environment);
				const module = `__qf/env/${environment}.js`;
				if (pkg && !(module in modules)) {
					// Claimed before linking: test files of one wave load concurrently.
					modules[module] = { js: "" };
					modules[module] = { js: `import * as __qf_ns from ${JSON.stringify(await link(pkg, name, "esm"))};\nexport default __qf_ns;` };
				}
			}
			let js = /\.(m?ts|tsx|jsx)$/.test(name) ? stripTypes(source, name) : source;
			const split = tests.has(name) ? splitMocks(js) : undefined;
			if (split) {
				const file = `__qf_mocks__${name.slice(name.lastIndexOf("/") + 1)}.js`;
				const path = `${dirname(name)}${file}`;
				const keys = await Promise.all(split.specs.map((s) => link(s, name, "esm")));
				const hoisted = rewriteImportActual(split.hoisted).replace(/__QF_MOCK_(\d+)__/g, (_, i: string) => JSON.stringify(keys[Number(i)]));
				const exported = split.names.length ? `export { ${split.names.join(", ")} };` : "";
				repoFiles.set(path, `import { vi } from "vitest";\n${hoisted}\n${exported}\n`);
				realOnly.add(path);
				enqueue(path);
				for (const key of keys) mockKeys.add(key);
				mocksOf.set(name, { module: `/${path}`, keys: new Set(keys), original: /\bimportOriginal\b|\bvi\s*\.\s*importActual\b/.test(split.hoisted) });
				// On the first line, so line numbers in stack traces still match the file.
				js = (split.names.length ? `import { ${split.names.join(", ")} } from "./${file}"; ` : "") + split.rest;
			}
			js = replaceImportMeta(rewriteImportActual(js), name);
			const imports = importsOf(js);
			const specifiers = [...new Set(imports.map((i) => i.n!))];
			const links = new Map(
				await Promise.all(specifiers.map(async (s) => [s, await link(s.endsWith(ACTUAL) ? s.slice(0, -ACTUAL.length) : s, name, "esm")] as const)),
			);
			const names = new Map<string, string[]>();
			for (const imp of imports) {
				if (imp.d !== -1) continue;
				names.set(imp.n!, [...(names.get(imp.n!) ?? []), ...importedNames(js.slice(imp.ss, imp.s))]);
			}
			esm.set(name, { js, links, names, real: realOnly.has(name) });
		}
	};

	for (const path of [...setupFiles, ...testFiles]) {
		if (repoFiles.has(path)) enqueue(path);
		else {
			unresolved.push({ specifier: path, from: "quality-flare.json" });
			modules[path] = { js: `throw new Error(${JSON.stringify(`quality-flare.json cita "${path}", que não existe no repositório.`)});` };
		}
	}
	// Breadth first, one wave at a time, so packages download in parallel.
	while (queue.length) {
		const wave = queue;
		queue = [];
		await Promise.all(wave.map(load));
	}

	const exportNames = (key: string): string[] => {
		const cjs = facades.get(key.slice(1));
		if (cjs) return [...cjsExportNames(cjs, sourceOf, cjsEdges)];
		const m = esm.get(key.slice(1));
		try {
			return m ? parse(m.js)[1].map((e) => e.n) : [];
		} catch {
			return [];
		}
	};
	const mockFacade = (key: string) => `__qf/mock/${key.replace(/^\//, "").replace(/[^\w./@-]+/g, "_")}`;
	const isMockLink = (m: EsmModule, specifier: string) => !m.real && !specifier.endsWith(ACTUAL) && mockKeys.has(m.links.get(specifier)!);
	const target = (m: EsmModule, s: string) => (isMockLink(m, s) ? `/${mockFacade(m.links.get(s)!)}` : m.links.get(s)!);
	// vi.resetModules(): a file that calls it imports the repository modules it loads dynamically
	// from fresh copies, one set per reset, since a module can't be evaluated twice.
	const isRepoModule = (link: string) => link.startsWith("/") && esm.has(link.slice(1)) && !link.startsWith(`/${PACKAGES_DIR}/`) && !link.startsWith("/__qf/");
	const resetting = testFiles.filter((path) => RESET_MODULES.test(esm.get(path)?.js ?? ""));
	const fresh = new Set<string>();
	const stack = resetting.flatMap((path) => {
		const m = esm.get(path)!;
		return importsOf(m.js).filter((i) => i.d > -1).map((i) => target(m, i.n!)).filter(isRepoModule).map((link) => link.slice(1));
	});
	while (stack.length) {
		const name = stack.pop()!;
		if (fresh.has(name)) continue;
		fresh.add(name);
		const m = esm.get(name)!;
		for (const s of m.links.keys()) if (isRepoModule(target(m, s))) stack.push(target(m, s).slice(1));
	}
	for (const [name, m] of esm) {
		const dynamic = resetting.includes(name)
			? (s: string) => (fresh.has(target(m, s).slice(1)) ? `__qf_fresh(${JSON.stringify(target(m, s))}, ${FRESH_COPIES})` : undefined)
			: undefined;
		modules[name] = { js: rewriteImports(m.js, (s) => target(m, s), dynamic) };
		if (!fresh.has(name)) continue;
		for (let copy = 0; copy < FRESH_COPIES; copy++) {
			modules[`__qf/fresh/${copy}/${name}`] = {
				js: rewriteImports(m.js, (s) => (fresh.has(target(m, s).slice(1)) ? `/__qf/fresh/${copy}${target(m, s)}` : target(m, s))),
			};
		}
	}
	for (const key of mockKeys) {
		const names = new Set<string>(exportNames(key));
		for (const m of esm.values()) {
			for (const [specifier, taken] of m.names) if (m.links.get(specifier) === key) for (const n of taken) names.add(n);
		}
		const list = [...names].filter(isExportableName);
		modules[mockFacade(key)] = {
			js: `import { mockFacade } from "/${RUNTIME_MODULE}";
let __qf_default${list.map((n) => `, ${n}`).join("")};
export { __qf_default as default${list.map((n) => `, ${n}`).join("")} };
mockFacade(${JSON.stringify(key)}, (__qf_ns) => {
	__qf_default = __qf_ns.default;${list.map((n) => ` ${n} = __qf_ns.${n};`).join("")}
});`,
		};
	}
	/**
	 * Mocked modules a file may import, dependencies first, so each is ready before what imports
	 * it. A module the file mocks is not entered, unless its factory may load the original.
	 */
	const reachOf = (path: string) => {
		const own = mocksOf.get(path);
		const out = new Set<string>();
		const seen = new Set<string>();
		const visit = (name: string) => {
			const m = esm.get(name);
			if (seen.has(name) || !m) return;
			seen.add(name);
			for (const [specifier, target] of m.links) {
				const mocked = isMockLink(m, specifier);
				if ((!mocked || !own?.keys.has(target) || own.original) && target.startsWith("/")) visit(target.slice(1));
				if (mocked) out.add(target);
			}
		};
		if (own) visit(own.module.slice(1));
		for (const setup of setupFiles) visit(setup);
		visit(path);
		return [...out];
	};
	const registry: Record<string, { mocks?: string; reach: string[]; environment?: string; setup?: Record<string, string> }> = {};
	testFiles.forEach((path, i) => {
		// Each file gets its own copy of the setup files, as vitest re-runs them per file; their
		// imports are absolute already, so a copy shares everything else.
		const setup: Record<string, string> = {};
		for (const file of setupFiles) {
			const copy = `__qf/setup/${i}/${file}`;
			if (testFiles.length > 1 && esm.has(file)) modules[copy] = modules[file];
			setup[`/${file}`] = `/${copy in modules ? copy : file}`;
		}
		registry[`/${path}`] = {
			mocks: mocksOf.get(path)?.module,
			reach: mockKeys.size ? reachOf(path) : [],
			environment: environments.get(path),
			setup,
		};
	});
	modules[FILES_MODULE] = { js: `export default ${JSON.stringify(registry)};` };
	// The rest of the repository, and the stylesheets of the packages in use, for tests and
	// packages that read them with node:fs under /bundle.
	let assets = 0;
	const addAsset = (path: string, text: string | undefined) => {
		if (text === undefined || path in modules || text.includes("\0") || assets + text.length > ASSET_CHARS) return;
		modules[path] = { text };
		assets += text.length;
	};
	for (const [path, text] of repoFiles) addAsset(path, text);
	for (const pkg of packageByDir.values()) {
		for (const path of pkg.files.keys()) if (path.endsWith(".css")) addAsset(`${pkg.dir}/${path}`, pkg.files.get(path));
	}
	// vitest mocks a module that doesn't resolve (e.g. "server-only") without complaint.
	const stillMissing = unresolved.filter((u) => !mockKeys.has(missingNames.get(u) ?? ""));
	unresolved.length = 0;
	unresolved.push(...stillMissing);

	for (const [facade, target] of facades) {
		const names = [...cjsExportNames(target, sourceOf, cjsEdges)].filter(isExportableName);
		modules[facade] = {
			js: `import __qf_cjs from "/${target}";
export default __qf_cjs && __qf_cjs.__esModule && "default" in __qf_cjs ? __qf_cjs.default : __qf_cjs;
${names.length ? `export const { ${names.join(", ")} } = __qf_cjs ?? {};` : ""}`,
		};
	}
	return { testFiles: testFiles.map((p) => `/${p}`), setupFiles: setupFiles.map((p) => `/${p}`), modules, unresolved };
}

/** Bytes of code in a bundle, as the Worker Loader counts them against its size limit (roughly). */
export function bundleSize(bundle: TestBundle): number {
	let size = 0;
	for (const module of Object.values(bundle.modules)) {
		const m = module as { js?: string; cjs?: string; text?: string; json?: unknown };
		size += (m.js ?? m.cjs ?? m.text ?? JSON.stringify(m.json) ?? "").length;
	}
	return size;
}

const REQUIRE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const REQUIRE_RESOLVE = /\brequire\.resolve\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

function importsOf(source: string) {
	return parse(source)[0].filter((imp) => imp.n !== undefined && imp.d !== -2 && (imp.d === -1 || /^["'`]/.test(source.slice(imp.s, imp.e))));
}

/** `with { type: "json" }` after a static import's closing quote. */
const JSON_ATTRIBUTES = /^(["'])\s*(?:with|assert)\s*\{\s*type\s*:\s*(["'])json\2\s*,?\s*\}/;

/**
 * Replaces every static and literal dynamic import specifier with `map(specifier)`. JSON import
 * attributes are dropped: the Worker Loader rejects them, and `.json` files load as JSON anyway.
 */
function rewriteImports(source: string, map: (specifier: string) => string, dynamic?: (specifier: string) => string | undefined): string {
	let out = "";
	let last = 0;
	for (const imp of importsOf(source)) {
		const replacement = map(imp.n!);
		const expression = imp.d > -1 ? (dynamic?.(imp.n!) ?? JSON.stringify(replacement)) : replacement;
		out += source.slice(last, imp.s) + expression;
		last = imp.e;
		const attributes = imp.d === -1 ? JSON_ATTRIBUTES.exec(source.slice(imp.e, imp.e + 64)) : null;
		if (attributes) {
			out += attributes[1];
			last += attributes[0].length;
		}
	}
	return out + source.slice(last);
}

/**
 * Dynamic Workers leave `import.meta.url` and `dirname` undefined. Every module is also a file
 * under /bundle (process.cwd()) in workerd's node:fs, so these point there.
 */
function replaceImportMeta(js: string, name: string): string {
	let out = "";
	let last = 0;
	// The lexer finds the real `import.meta`s (d === -2), not those in strings and comments.
	for (const imp of parse(js)[0]) {
		if (imp.d !== -2) continue;
		const key = /^\s*\.\s*(url|dirname|filename)\b/.exec(js.slice(imp.e, imp.e + 32));
		if (!key) continue;
		out += js.slice(last, imp.s) + JSON.stringify(importMeta(name, key[1]));
		last = imp.e + key[0].length;
	}
	return out + js.slice(last);
}
const BUNDLE_ROOT = "/bundle";
/** Repository files added as text, beyond the modules: what a shard's bundle can spare. */
const ASSET_CHARS = 16 * 1024 * 1024;

function importMeta(name: string, key: string): string {
	const filename = `${BUNDLE_ROOT}/${name}`;
	if (key === "url") return `file://${filename}`;
	return key === "filename" ? filename : filename.slice(0, filename.lastIndexOf("/"));
}

/** The names an import or re-export statement takes: `import a, { b, c as d } from`, `export { e } from`. */
function importedNames(statement: string): string[] {
	const braces = /\{([^}]*)\}/.exec(statement);
	if (!braces) return [];
	return braces[1]
		.split(",")
		.map((item) => item.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "").replace(/^["']|["']$/g, ""))
		.filter((n) => n && n !== "default");
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
		...(typescript ? [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`] : []),
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
function entryOf(json: PackageJson, subpath: string | undefined, importer: Kind): string | undefined {
	if (json.exports) {
		return resolveConditions((conditions) => packageExports(json, `.${subpath ?? ""}`, { conditions, unsafe: true }), importer);
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

/** `require()` gets a package's CommonJS build, as in Node; `import` its ES module build. */
function resolveConditions(fn: (conditions: string[]) => string[] | void, importer: Kind): string | undefined {
	for (const conditions of importer === "cjs" ? [CJS_CONDITIONS, ESM_CONDITIONS] : [ESM_CONDITIONS, CJS_CONDITIONS]) {
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

/** A locked package whose download or reading failed. */
class DownloadFailed extends Error {
	constructor(locked: LockedPackage, cause: unknown) {
		super(`não foi possível baixar ${locked.name}@${locked.version} do npm (${cause instanceof Error ? cause.message : String(cause)})`);
	}
}

function missingMessage(specifier: string, from: string): string {
	const isPackage = !/^[./#]/.test(specifier);
	return isPackage
		? `"${from}" importa o pacote "${specifier}", que não está no lockfile (pnpm-lock.yaml ou package-lock.json) ou não pôde ser baixado do npm.`
		: `"${from}" importa "${specifier}", que não foi encontrado.`;
}

/** TypeScript and JSX to plain JavaScript; JSX through React's automatic runtime, as Vite's React plugin does. */
function stripTypes(source: string, path: string): string {
	const jsx = /\.[jt]sx$/.test(path);
	const transforms: ("typescript" | "jsx")[] = path.endsWith(".jsx") ? ["jsx"] : jsx ? ["typescript", "jsx"] : ["typescript"];
	return transform(source, { transforms, disableESTransforms: true, filePath: path, jsxRuntime: "automatic", production: true }).code;
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
