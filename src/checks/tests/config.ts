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
	/** vitest's `environment` for files without a `@vitest-environment` comment: node, jsdom or happy-dom. */
	environment?: string;
	/** Before each test, as vitest's options of the same name: the first one set wins, in this order. */
	restoreMocks?: boolean;
	mockReset?: boolean;
	/** Defaults to vitest's own default for the version in the lockfile: true from vitest 5. */
	clearMocks?: boolean;
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
	if (tests.environment !== undefined && typeof tests.environment !== "string") throw new Error(`${CONFIG_FILE}: "tests.environment" deve ser um texto.`);
	for (const key of ["globals", "clearMocks", "mockReset", "restoreMocks"] as const) {
		if (tests[key] !== undefined && typeof tests[key] !== "boolean") throw new Error(`${CONFIG_FILE}: "tests.${key}" deve ser true ou false.`);
	}
	if (tests.testTimeout !== undefined && !(typeof tests.testTimeout === "number" && tests.testTimeout > 0)) {
		throw new Error(`${CONFIG_FILE}: "tests.testTimeout" deve ser um número de milissegundos.`);
	}
	return tests;
}

/**
 * The `container` section of quality-flare.json, for the "Container tests" check. There the
 * repository's own vitest and config run, so the `tests` section doesn't apply.
 *
 * { "container": { "vitestArgs": ["--config", "vitest.unit.config.mts"],
 *   "commands": { "Typecheck": "npm run typecheck", "Lint": "npm run lint" } } }
 */
export interface ContainerConfig {
	/** Shell command that installs dependencies; by default the lockfile's package manager, without install scripts. */
	install?: string;
	/** Arguments to `vitest run`, before the reporters quality-flare adds. */
	vitestArgs?: string[];
	/** Shell commands run after the tests, in order, each reported as the check run named by its key. */
	commands?: Record<string, string>;
	/** Shorthand for a "Typecheck" command, run before the others. */
	typecheck?: string;
	/**
	 * Runs only the test files that depend on what the PR changed (`vitest --changed origin/<base>`). A daily
	 * full run on the default branch catches what that misses (src/checks/tests/daily.ts).
	 */
	changed?: boolean;
	/**
	 * With `changed`, vitest filters (paths) that run on every PR anyway: tests that read files or run scripts,
	 * which vitest's module graph can't connect to the change, such as { "alwaysRun": ["bin/"] }.
	 */
	alwaysRun?: string[];
	/** Gives Turborepo, in the commands, a remote cache shared by the repository's runs (src/turbo-cache.ts). */
	turboCache?: boolean;
}

/** A command of the container section, and the check run it reports as. */
export interface ContainerCommand {
	name: string;
	run: string;
}

/** More commands than this make a run too long for its deadline anyway. */
export const MAX_COMMANDS = 8;

/** The `container` section of quality-flare.json; empty when the file is missing. Throws when it is invalid. */
export function readContainerConfig(source: string | undefined): ContainerConfig {
	if (source === undefined) return {};
	let json: { container?: ContainerConfig };
	try {
		json = JSON.parse(source);
	} catch (error) {
		throw new Error(`${CONFIG_FILE} não é um JSON válido: ${error instanceof Error ? error.message : String(error)}`);
	}
	const container = json.container ?? {};
	for (const key of ["install", "typecheck"] as const) {
		if (container[key] !== undefined && typeof container[key] !== "string") throw new Error(`${CONFIG_FILE}: "container.${key}" deve ser um texto.`);
	}
	for (const key of ["changed", "turboCache"] as const) {
		if (container[key] !== undefined && typeof container[key] !== "boolean") throw new Error(`${CONFIG_FILE}: "container.${key}" deve ser true ou false.`);
	}
	for (const key of ["vitestArgs", "alwaysRun"] as const) {
		const list = container[key];
		if (list !== undefined && !(Array.isArray(list) && list.every((a) => typeof a === "string" && a.trim() !== "" && !a.includes("\n")))) {
			throw new Error(`${CONFIG_FILE}: "container.${key}" deve ser uma lista de textos.`);
		}
	}
	const commands = container.commands;
	if (commands !== undefined) {
		if (typeof commands !== "object" || commands === null || Array.isArray(commands) || !Object.values(commands).every((c) => typeof c === "string")) {
			throw new Error(`${CONFIG_FILE}: "container.commands" deve ligar o nome de cada check run ao seu comando, como { "Lint": "npm run lint" }.`);
		}
		for (const name of Object.keys(commands)) {
			if (!name.trim() || name.length > 60 || name.includes("\n")) throw new Error(`${CONFIG_FILE}: "${name}" não serve de nome de check run em "container.commands".`);
		}
	}
	const all = containerCommands(container);
	if (new Set(all.map((c) => c.name.toLowerCase())).size < all.length) {
		throw new Error(`${CONFIG_FILE}: "container.typecheck" já é o comando "Typecheck"; não repita esse nome em "container.commands".`);
	}
	if (all.length > MAX_COMMANDS) throw new Error(`${CONFIG_FILE}: "container.commands" aceita até ${MAX_COMMANDS} comandos.`);
	return container;
}

/** The commands a container run reports on, in the order it runs them. */
export function containerCommands(config: ContainerConfig): ContainerCommand[] {
	return [
		...(config.typecheck ? [{ name: "Typecheck", run: config.typecheck }] : []),
		...Object.entries(config.commands ?? {}).map(([name, run]) => ({ name, run })),
	];
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
