import { INSTANCES, type InstanceType } from "./instances.ts";

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
		throw new Error(`${CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const tests = json.tests ?? {};
	const strings = (key: keyof TestConfig) => {
		const value = tests[key];
		if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
			throw new Error(`${CONFIG_FILE}: "tests.${key}" must be a list of strings.`);
		}
	};
	strings("include");
	strings("exclude");
	strings("setupFiles");
	if (tests.environment !== undefined && typeof tests.environment !== "string") throw new Error(`${CONFIG_FILE}: "tests.environment" must be a string.`);
	for (const key of ["globals", "clearMocks", "mockReset", "restoreMocks"] as const) {
		if (tests[key] !== undefined && typeof tests[key] !== "boolean") throw new Error(`${CONFIG_FILE}: "tests.${key}" must be true or false.`);
	}
	if (tests.testTimeout !== undefined && !(typeof tests.testTimeout === "number" && tests.testTimeout > 0)) {
		throw new Error(`${CONFIG_FILE}: "tests.testTimeout" must be a number of milliseconds.`);
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
	 * Runs only the test files that depend on what the PR changed (`vitest --changed origin/<base>`), where a
	 * package.json or package-lock.json change stands for the files that use the packages it changed
	 * (containers/tests/qf-related.mjs). A daily full run on the default branch catches what that misses
	 * (src/checks/tests/daily.ts).
	 */
	changed?: boolean;
	/**
	 * With `changed`, vitest filters (paths) that run on every PR anyway: tests that read files or run scripts,
	 * which vitest's module graph can't connect to the change, such as { "alwaysRun": ["bin/"] }.
	 */
	alwaysRun?: string[];
	/** Gives Turborepo, in the commands, a remote cache shared by the repository's runs (src/turbo-cache.ts). */
	turboCache?: boolean;
	/**
	 * Paths, relative to the repository root, that the repository's runs keep from one to the next: the caches its
	 * tools write (ESLint's `--cache-location`, tsc's .tsbuildinfo…). Kept per lockfile, so new dependencies start
	 * them over; such a cache must only skip work whose inputs didn't change, as ESLint's `--cache-strategy content` does.
	 */
	cache?: string[];
	/**
	 * Starts each run from a snapshot of the last container that installed the base branch's lockfile, with the
	 * clone and node_modules already there, so a run on that lockfile skips the install (src/checks/tests/container.ts).
	 */
	snapshot?: boolean;
	/** The container's instance type (INSTANCES in instances.ts); DEFAULT_INSTANCE, standard-4, by default. */
	instance?: InstanceType;
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
		throw new Error(`${CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const container = json.container ?? {};
	if (container.instance !== undefined && !Object.hasOwn(INSTANCES, container.instance)) {
		throw new Error(`${CONFIG_FILE}: "container.instance" must be one of these instance types: ${Object.keys(INSTANCES).join(", ")}.`);
	}
	for (const key of ["install", "typecheck"] as const) {
		if (container[key] !== undefined && typeof container[key] !== "string") throw new Error(`${CONFIG_FILE}: "container.${key}" must be a string.`);
	}
	for (const key of ["changed", "turboCache", "snapshot"] as const) {
		if (container[key] !== undefined && typeof container[key] !== "boolean") throw new Error(`${CONFIG_FILE}: "container.${key}" must be true or false.`);
	}
	for (const key of ["vitestArgs", "alwaysRun", "cache"] as const) {
		const list = container[key];
		if (list !== undefined && !(Array.isArray(list) && list.every((a) => typeof a === "string" && a.trim() !== "" && !a.includes("\n")))) {
			throw new Error(`${CONFIG_FILE}: "container.${key}" must be a list of strings.`);
		}
	}
	for (const path of container.cache ?? []) {
		// The cache is restored over a fresh checkout: the root or .git would bring back an earlier commit.
		const parts = path.split("/").filter((part) => part !== "" && part !== ".");
		if (path.startsWith("/") || parts.includes("..") || !parts.length || parts[0] === ".git") {
			throw new Error(`${CONFIG_FILE}: "${path}" in "container.cache" must be a path inside the repository, outside .git and below the root.`);
		}
	}
	const commands = container.commands;
	if (commands !== undefined) {
		if (typeof commands !== "object" || commands === null || Array.isArray(commands) || !Object.values(commands).every((c) => typeof c === "string")) {
			throw new Error(`${CONFIG_FILE}: "container.commands" must map each check run name to its command, like { "Lint": "npm run lint" }.`);
		}
		for (const name of Object.keys(commands)) {
			if (!name.trim() || name.length > 60 || name.includes("\n")) throw new Error(`${CONFIG_FILE}: "${name}" is not a valid check run name in "container.commands".`);
		}
	}
	const all = containerCommands(container);
	if (new Set(all.map((c) => c.name.toLowerCase())).size < all.length) {
		throw new Error(`${CONFIG_FILE}: "container.typecheck" is already the "Typecheck" command. Do not repeat that name in "container.commands".`);
	}
	if (all.length > MAX_COMMANDS) throw new Error(`${CONFIG_FILE}: "container.commands" accepts up to ${MAX_COMMANDS} commands.`);
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
