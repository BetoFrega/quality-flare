#!/usr/bin/env node
// qf-related <base> [<vitest config>]: the files a PR changed since <base>, as vitest's --changed
// should see them, for Container tests runs of only the affected tests (qf-run.sh). Prints one path per
// line, or "all" when every test must run.
//
// vitest runs every test when any package.json changed (its forceRerunTriggers) and ignores lockfiles,
// whose packages live in node_modules, outside its module graph. Instead:
// - a package-lock.json stands for the packages whose entries changed, plus every package that
//   depends on them, by name (an optional peer dependency, such as vitest's on jsdom, is used only
//   where a file names it). Type packages (@types/*) don't run, so they stand for nothing;
// - a package.json stands for the files that name package.json when its scripts or other npm
//   metadata changed, and without a package-lock.json, for the packages whose dependency entries
//   changed (with one, what they install is in its diff). Any other change to a workspace's stands
//   for every file of the workspace; to the root's (workspaces, overrides), for everything;
// - such a package stands for the repository's files that name it in quotes, as imports, mocks and
//   configs do, or in a @vitest-environment comment. One the vitest config or what it imports names
//   (vite, a plugin), or vitest itself, runs everything.
// Other lockfiles (pnpm, yarn) aren't read: they run everything. Why everything runs goes to stderr.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"];
// package.json fields only npm reads, which change no module: tests that read them name package.json.
const METADATA_FIELDS = ["scripts", "engines", "description", "version", "private", "author", "contributors", "license", "repository", "keywords", "homepage", "bugs", "funding"];
const MANIFEST = /(^|\/)package\.json$/;
const NPM_LOCKFILE = /^(package-lock|npm-shrinkwrap)\.json$/;
const OTHER_LOCKFILE = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json)$/;
const CONFIGS = ["vitest", "vite"].flatMap((name) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((extension) => `${name}.config.${extension}`));
// vitest runs every test when one of these changes (its forceRerunTriggers), even the config of a
// workspace's own vite or vitest, which the root's run doesn't load.
const RERUN_TRIGGER = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
const lines = (text) => text.split("\0").filter(Boolean);

/** The file at <base>, or undefined if it didn't exist there. */
function atBase(base, path) {
	try {
		return execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function current(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

const json = (text) => (text === undefined ? undefined : JSON.parse(text));

/** The dependency names whose specs differ between two manifests' fields. */
function changedDependencies(before, after) {
	const names = new Set();
	for (const field of DEPENDENCY_FIELDS) {
		const a = before?.[field] ?? {};
		const b = after?.[field] ?? {};
		for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) names.add(name);
		}
	}
	return names;
}

const without = (manifest, fields) => JSON.stringify({ ...manifest, ...Object.fromEntries(fields.map((field) => [field, undefined])) });

const runs = (name) => !name.startsWith("@types/");

/** An npm lockfile entry's package name: "node_modules/a/node_modules/@s/b" is "@s/b". */
const entryName = (key, entry) => entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

const installed = (entry) =>
	JSON.stringify([entry.version, entry.resolved, entry.integrity, entry.link, entry.dependencies, entry.optionalDependencies, entry.peerDependencies]);

/**
 * The packages a package-lock.json change reaches, each with the changed package that reaches it: the
 * ones whose entries changed, and by name every package that depends on one of those, in either
 * version of the lockfile. Workspaces' own entries are left out: their files are in the diff.
 */
function lockfilePackages(before, after) {
	const external = (lock) =>
		Object.entries(lock?.packages ?? {}).filter(([key, entry]) => key.includes("node_modules/") && !entry.link);
	const old = new Map(external(before));
	const now = new Map(external(after));
	const changed = new Map();
	for (const key of new Set([...old.keys(), ...now.keys()])) {
		const a = old.get(key);
		const b = now.get(key);
		const name = entryName(key, a ?? b);
		if ((!a || !b || installed(a) !== installed(b)) && runs(name)) changed.set(name, name);
	}
	const dependents = new Map();
	for (const entries of [old, now]) {
		for (const [key, entry] of entries) {
			const name = entryName(key, entry);
			const peers = Object.keys(entry.peerDependencies ?? {}).filter((peer) => !entry.peerDependenciesMeta?.[peer]?.optional);
			for (const dependency of [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...peers]) {
				if (!dependents.has(dependency)) dependents.set(dependency, new Set());
				dependents.get(dependency).add(name);
			}
		}
	}
	const queue = [...changed.keys()];
	while (queue.length) {
		const name = queue.pop();
		for (const dependent of dependents.get(name) ?? []) {
			if (!changed.has(dependent) && runs(dependent)) {
				changed.set(dependent, changed.get(name));
				queue.push(dependent);
			}
		}
	}
	return changed;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The tracked files that name one of the packages: in quotes ("zod", 'zod/v4'), or as a vitest
 * environment; and with manifest, the ones that name a package.json ("../package.json").
 */
function filesNaming(names, manifest) {
	const patterns = [];
	// git grep takes the patterns from the command line, so in chunks.
	for (let i = 0; i < names.length; i += 200) {
		const alternatives = names.slice(i, i + 200).map(escape).join("|");
		patterns.push(`["'\`](${alternatives})(["'\`/])|@vitest-environment[[:space:]]+(${alternatives})([^[:alnum:]_./-]|$)`);
	}
	if (manifest) patterns.push(`package\\.json["'\`]`);
	const files = new Set();
	for (const pattern of patterns) {
		try {
			for (const file of lines(git("grep", "-z", "-l", "-E", "-e", pattern, "--", ".", ":(exclude,glob)**/package.json", ":(exclude,glob)**/package-lock.json"))) files.add(file);
		} catch (error) {
			// Exit code 1: no file matches.
			if (error.status !== 1) throw error;
		}
	}
	return files;
}

/** The vitest config and the local files it imports, as written: relative specifiers, one level of extension guessing. */
function configFiles(config) {
	const files = new Set();
	const queue = [config ?? CONFIGS.find((file) => existsSync(file))].filter(Boolean);
	while (queue.length) {
		const file = normalize(queue.pop());
		if (files.has(file) || !existsSync(file)) continue;
		files.add(file);
		for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
			const path = join(dirname(file), specifier);
			queue.push([path, ...["ts", "mts", "js", "mjs"].map((extension) => `${path}.${extension}`)].find((candidate) => existsSync(candidate)) ?? path);
		}
	}
	return files;
}

/** Every test runs, for a reason printed to stderr. */
function all(reason) {
	process.stderr.write(`${reason}\n`);
	return "all";
}

function related(base, config) {
	const diff = lines(git("diff", "-z", "--name-only", "--no-renames", base, "HEAD"));
	const files = new Set();
	// Package name -> the changed package that reaches it.
	const packages = new Map();
	let metadata = false;
	const locked = existsSync("package-lock.json") || existsSync("npm-shrinkwrap.json");
	for (const path of diff) {
		if (NPM_LOCKFILE.test(path)) {
			for (const [name, cause] of lockfilePackages(json(atBase(base, path)), json(current(path)))) packages.set(name, cause);
		} else if (OTHER_LOCKFILE.test(path)) {
			return all(`${path} changed, and only package-lock.json is read.`);
		} else if (MANIFEST.test(path)) {
			const before = json(atBase(base, path));
			const after = json(current(path));
			if (!locked) for (const name of changedDependencies(before, after)) if (runs(name)) packages.set(name, name);
			// A workspace added or removed: its files are in the diff.
			if (!before || !after) {
				if (path === "package.json") return all("package.json was created or removed.");
			} else if (without(before, DEPENDENCY_FIELDS) !== without(after, DEPENDENCY_FIELDS)) {
				metadata = true;
				if (without(before, [...DEPENDENCY_FIELDS, ...METADATA_FIELDS]) === without(after, [...DEPENDENCY_FIELDS, ...METADATA_FIELDS])) continue;
				if (path === "package.json") return all("package.json changed beyond dependencies and scripts.");
				for (const file of lines(git("ls-files", "-z", "--", path.slice(0, -"package.json".length)))) {
					if (!RERUN_TRIGGER.test(file)) files.add(file);
				}
			}
		} else {
			files.add(path);
		}
	}
	const naming = [...filesNaming([...packages.keys()], metadata)];
	for (const [name, cause] of packages) {
		if (name === "vitest" || name === "vite" || name.startsWith("@vitest/")) return all(cause === name ? `${name} changed.` : `${cause} changed and ${name} depends on it.`);
	}
	const configs = configFiles(config);
	const configuring = naming.find((file) => configs.has(file));
	if (configuring) return all(`${configuring} uses a package that changed.`);
	return [...new Set([...files, ...naming.filter((file) => !RERUN_TRIGGER.test(file))])];
}

const result = related(process.argv[2], process.argv[3]);
process.stdout.write(result === "all" ? "all\n" : result.map((file) => `${file}\n`).join(""));
