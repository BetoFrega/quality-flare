/**
 * Optional `quality-flare.json` at the repository root: which test files the Tests check runs
 * and how, mirroring the vitest config they come from. Without it, the convention in
 * convention.ts applies.
 *
 * { "tests": { "include": ["src/**\/*.test.ts"], "exclude": ["**\/*.integration.test.ts"],
 *   "setupFiles": ["vitest.setup.ts"], "globals": true, "testTimeout": 20000 } }
 */

export const CONFIG_FILE = "quality-flare.json";

export interface TestConfig {
	/** Globs of test files, as vitest's `include`. Replaces the `*.test.*` convention. */
	include?: string[];
	/** Globs left out, as vitest's `exclude`; node_modules is always left out. */
	exclude?: string[];
	/** Files run before each test file, as vitest's `setupFiles`. */
	setupFiles?: string[];
	/** Exposes `describe`, `it`, `expect`, `vi`… as globals, as vitest's `globals`. */
	globals?: boolean;
	/** Milliseconds per test, as vitest's `testTimeout`. */
	testTimeout?: number;
}

/** The `tests` section of quality-flare.json; empty when the file is missing. Throws when it is invalid. */
export function readTestConfig(source: string | undefined): TestConfig {
	if (source === undefined) return {};
	let json: { tests?: TestConfig };
	try {
		json = JSON.parse(source);
	} catch (error) {
		throw new Error(`${CONFIG_FILE} não é um JSON válido: ${error instanceof Error ? error.message : String(error)}`);
	}
	const tests = json.tests ?? {};
	const strings = (key: keyof TestConfig) => {
		const value = tests[key];
		if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
			throw new Error(`${CONFIG_FILE}: "tests.${key}" deve ser uma lista de textos.`);
		}
	};
	strings("include");
	strings("exclude");
	strings("setupFiles");
	if (tests.globals !== undefined && typeof tests.globals !== "boolean") throw new Error(`${CONFIG_FILE}: "tests.globals" deve ser true ou false.`);
	if (tests.testTimeout !== undefined && !(typeof tests.testTimeout === "number" && tests.testTimeout > 0)) {
		throw new Error(`${CONFIG_FILE}: "tests.testTimeout" deve ser um número de milissegundos.`);
	}
	return tests;
}

/** Test files picked by the config's include/exclude, or by `convention` when it has no include. */
export function selectTestFiles(paths: string[], config: TestConfig, convention: (path: string) => boolean): string[] {
	const include = config.include?.map(globToRegExp);
	const exclude = [...(config.exclude ?? []), "**/node_modules/**"].map(globToRegExp);
	return paths.filter((p) => (include ? include.some((g) => g.test(p)) : convention(p)) && !exclude.some((g) => g.test(p)));
}

/** A glob as vitest writes them: `**`, `*`, `?` and `{a,b}`, relative to the repository root. */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	const pattern = glob.replace(/^\.\//, "");
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			// "**/" matches any number of folders, including none.
			const slash = pattern[i + 2] === "/";
			out += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else if (c === "{") {
			const end = pattern.indexOf("}", i);
			out += `(?:${pattern.slice(i + 1, end).split(",").map(escape).join("|")})`;
			i = end;
		} else out += escape(c);
	}
	return new RegExp(`^${out}$`);
}

const escape = (text: string) => text.replace(/[.+^$()|[\]\\]/g, "\\$&");
