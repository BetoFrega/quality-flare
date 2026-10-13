import type { TestConfig } from "./config.ts";

/**
 * The vitest config files the Tests check reads, in order: the first one in the repository wins.
 * A unit config comes first because a repository that has one runs its other tiers elsewhere.
 */
export const VITEST_CONFIGS = ["unit.config", "config"].flatMap((name) =>
	["mts", "ts", "mjs", "js", "cts", "cjs"].map((ext) => `vitest.${name}.${ext}`),
);

/** vitest's `configDefaults.exclude`. */
const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**"];

type Read = (path: string) => Promise<string | undefined>;

/**
 * The test settings of the repository's vitest config, read without running it: string arrays,
 * booleans and numbers written in its `test: {…}` blocks, following `mergeConfig` into local
 * config files it imports (arrays concatenate, as in vitest). Values computed at run time are
 * left out. Empty when the repository has no vitest config.
 */
export async function readVitestConfig(read: Read): Promise<{ path?: string; config: TestConfig }> {
	for (const path of VITEST_CONFIGS) {
		const source = await read(path);
		if (source !== undefined) return { path, config: await configOf(path, source, read, new Set([path])) };
	}
	return { config: {} };
}

async function configOf(path: string, source: string, read: Read, seen: Set<string>): Promise<TestConfig> {
	const code = blankOut(source);
	let config: TestConfig = {};
	// Local configs it imports, in the order the file uses them (mergeConfig(base, override)).
	const uses: { at: number; file: string }[] = [];
	for (const m of code.matchAll(/\bimport\s+([\w$]+|\{[^}]*\})\s+from\s*(["'])/g)) {
		const quote = m.index + m[0].length - 1;
		const specifier = source.slice(quote + 1, source.indexOf(m[2], quote + 1));
		if (!specifier.startsWith(".")) continue;
		const names = m[1].startsWith("{") ? m[1].slice(1, -1).split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!).filter(Boolean) : [m[1]];
		const after = quote + specifier.length + 2;
		for (const name of names) {
			const use = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).exec(code.slice(after));
			if (use) uses.push({ at: after + use.index, file: join(dirname(path), specifier) });
		}
	}
	for (const { file } of uses.sort((a, b) => a.at - b.at)) {
		for (const candidate of withExtensions(file)) {
			if (seen.has(candidate)) break;
			const imported = await read(candidate);
			if (imported === undefined) continue;
			seen.add(candidate);
			config = merge(config, await configOf(candidate, imported, read, seen));
			break;
		}
	}
	// Comments blanked out, strings kept: what the values are read from.
	const plain = blankOut(source, true);
	for (const m of code.matchAll(/(?<![\w$.])test\s*:\s*\{/g)) config = merge(config, testBlock(plain, code, m.index + m[0].length - 1));
	return config;
}

type Flag = "globals" | "clearMocks" | "mockReset" | "restoreMocks";
const BOOLEANS = new Set<string>(["globals", "clearMocks", "mockReset", "restoreMocks"] satisfies Flag[]);

function testBlock(source: string, code: string, open: number): TestConfig {
	const config: TestConfig = {};
	for (const [key, value] of entries(source, code, open)) {
		const text = source.slice(value.start, value.end).trim();
		if (key === "include" || key === "exclude" || key === "setupFiles") {
			const lead = value.end - value.start - source.slice(value.start, value.end).trimStart().length;
			const list = stringArray(text, code.slice(value.start + lead, value.start + lead + text.length));
			if (list) config[key] = list;
		} else if (BOOLEANS.has(key) && /^(true|false)$/.test(text)) config[key as Flag] = text === "true";
		else if (key === "testTimeout" && /^\d[\d_]*$/.test(text)) config.testTimeout = Number(text.replace(/_/g, ""));
		else if (key === "environment" && /^(["'`])[\w-]+\1$/.test(text)) config.environment = text.slice(1, -1);
	}
	return config;
}

/** `["a", 'b', ...configDefaults.exclude]`; undefined for anything else. `code` is `text` blanked out. */
function stringArray(text: string, code: string): string[] | undefined {
	if (!text.startsWith("[") || !text.endsWith("]")) return undefined;
	const out: string[] = [];
	let start = 1;
	for (let i = 1; i < code.length; i++) {
		if (code[i] !== "," && i !== code.length - 1) continue;
		const item = text.slice(start, i).trim();
		start = i + 1;
		if (!item) continue;
		const quoted = /^(["'`])([^"'`]*)\1$/.exec(item);
		if (quoted) out.push(quoted[2]);
		else if (item === "...configDefaults.exclude" || item === "...defaultExclude") out.push(...DEFAULT_EXCLUDE);
		else return undefined;
	}
	return out;
}

function merge(base: TestConfig, override: TestConfig): TestConfig {
	const out: TestConfig = { ...base, ...override };
	for (const key of ["include", "exclude", "setupFiles"] as const) {
		if (base[key] && override[key]) out[key] = [...base[key], ...override[key]];
	}
	return out;
}

/** The keys of the object literal opening at `open`, with where each value starts and ends. */
function entries(source: string, code: string, open: number): Map<string, { start: number; end: number }> {
	const out = new Map<string, { start: number; end: number }>();
	let depth = 0;
	let keyStart = open + 1;
	let value: { key: string; start: number } | undefined;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") {
			depth--;
			if (depth === 0) {
				if (value) out.set(value.key, { start: value.start, end: i });
				break;
			}
		} else if (depth === 1 && c === ":" && !value) {
			value = { key: source.slice(keyStart, i).trim().replace(/^["']|["']$/g, ""), start: i + 1 };
		} else if (depth === 1 && c === ",") {
			if (value) out.set(value.key, { start: value.start, end: i });
			value = undefined;
			keyStart = i + 1;
		}
	}
	return out;
}

/** The source with comments, and string contents unless `keepStrings`, replaced by spaces, so offsets still match. */
function blankOut(source: string, keepStrings = false): string {
	let out = "";
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			const stop = end === -1 ? source.length : end;
			out += " ".repeat(stop - i);
			i = stop - 1;
		} else if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			out += source.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop - 1;
		} else if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
			out += keepStrings ? source.slice(i, j + 1) : c + " ".repeat(Math.min(j, source.length) - i - 1) + (j < source.length ? c : "");
			i = j;
		} else out += c;
	}
	return out;
}

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function join(dir: string, specifier: string): string {
	const parts = dir ? dir.split("/") : [];
	for (const part of specifier.split("/")) {
		if (part === "..") parts.pop();
		else if (part !== ".") parts.push(part);
	}
	return parts.join("/");
}

const withExtensions = (file: string) => (/\.[cm]?[jt]s$/.test(file) ? [file] : ["mts", "ts", "mjs", "js"].map((ext) => `${file}.${ext}`));
