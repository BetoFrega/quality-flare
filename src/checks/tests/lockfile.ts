/**
 * Exact dependency versions from the repository's lockfile, so test files can import npm
 * packages without any configuration. Supports pnpm-lock.yaml (v9) and package-lock.json (v2/v3).
 */

export interface LockedPackage {
	/** Unique per resolution context (a pnpm snapshot id or a node_modules path). */
	key: string;
	name: string;
	version: string;
}

export interface Lockfile {
	/** The package `name` as seen from the repository file at `path`. */
	fromRepo(path: string, name: string): LockedPackage | undefined;
	/** The package `name` as seen from inside `pkg`. */
	fromPackage(pkg: LockedPackage, name: string): LockedPackage | undefined;
	/** The repository folder of workspace package `name`, as seen from the repository file at `path`. */
	workspace(path: string, name: string): string | undefined;
}

export function readLockfile(files: Map<string, string>): Lockfile | undefined {
	const pnpm = files.get("pnpm-lock.yaml");
	if (pnpm) return pnpmLockfile(parseYaml(pnpm));
	const npm = files.get("package-lock.json");
	if (npm) return npmLockfile(JSON.parse(npm));
	return undefined;
}

type YamlMap = { [key: string]: YamlMap | string };

interface PnpmLock {
	importers?: Record<string, Record<string, Record<string, { version: string }>>>;
	snapshots?: Record<string, Record<string, Record<string, string>>>;
}

function pnpmLockfile(lock: YamlMap): Lockfile {
	const { importers = {}, snapshots = {} } = lock as unknown as PnpmLock;
	// "8.3.4(@types/node@22)" → key "vite@8.3.4(@types/node@22)", version "8.3.4". Links are workspace packages.
	const locked = (name: string, version: string | undefined): LockedPackage | undefined =>
		version && !version.startsWith("link:") && !version.startsWith("file:")
			? { key: `${name}@${version}`, name, version: version.replace(/\(.*$/, "") }
			: undefined;
	const importerPaths = Object.keys(importers).sort((a, b) => b.length - a.length);
	const importerOf = (path: string) => importerPaths.find((dir) => dir === "." || path.startsWith(`${dir}/`));
	const versionFrom = (path: string, name: string) => {
		const importer = importerOf(path);
		const deps = importer ? importers[importer] : {};
		const dep = deps.dependencies?.[name] ?? deps.devDependencies?.[name] ?? deps.optionalDependencies?.[name];
		return { importer, version: dep?.version };
	};
	return {
		fromRepo: (path, name) => locked(name, versionFrom(path, name).version),
		workspace(path, name) {
			const { importer, version } = versionFrom(path, name);
			return version?.startsWith("link:") ? joinPath(importer === "." ? "" : importer!, version.slice("link:".length)) : undefined;
		},
		fromPackage(pkg, name) {
			const snapshot = snapshots[pkg.key] ?? {};
			return locked(name, snapshot.dependencies?.[name] ?? snapshot.optionalDependencies?.[name]);
		},
	};
}

interface NpmLock {
	packages?: Record<string, { version?: string; name?: string; link?: boolean; resolved?: string }>;
}

function npmLockfile(lock: NpmLock): Lockfile {
	const packages = lock.packages ?? {};
	// Node's lookup: the closest node_modules folder that has it, walking up.
	const find = (dir: string, name: string): LockedPackage | undefined => {
		for (let base = dir; ; ) {
			const key = `${base ? `${base}/` : ""}node_modules/${name}`;
			const entry = packages[key];
			if (entry?.version && !entry.link) return { key, name: entry.name ?? name, version: entry.version };
			if (!base) return undefined;
			const parent = base.lastIndexOf("/node_modules/");
			base = parent === -1 ? "" : base.slice(0, parent);
		}
	};
	// From a repository file, every folder above it may have a node_modules (workspace packages do).
	const ancestors = (path: string) => {
		const dirs: string[] = [];
		for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) dirs.push(path.slice(0, i));
		return [...dirs, ""];
	};
	const nearest = (path: string, name: string) => {
		for (const dir of ancestors(path)) {
			const key = `${dir ? `${dir}/` : ""}node_modules/${name}`;
			if (packages[key]) return { key, entry: packages[key] };
		}
		return undefined;
	};
	return {
		fromRepo(path, name) {
			const { key, entry } = nearest(path, name) ?? {};
			return key && entry?.version && !entry.link ? { key, name: entry.name ?? name, version: entry.version } : undefined;
		},
		fromPackage: (pkg, name) => find(pkg.key, name),
		workspace(path, name) {
			const { entry } = nearest(path, name) ?? {};
			return entry?.link ? entry.resolved : undefined;
		},
	};
}

/** Joins repository paths, resolving `.` and `..`. */
export function joinPath(dir: string, relative: string): string {
	const parts: string[] = [];
	for (const part of `${dir}/${relative}`.split("/")) {
		if (part === "..") parts.pop();
		else if (part !== "." && part !== "") parts.push(part);
	}
	return parts.join("/");
}

/**
 * Just enough YAML for pnpm lockfiles: nested block mappings with plain or quoted scalars.
 * Sequences and flow collections are kept as raw strings; nothing here reads them.
 */
export function parseYaml(text: string): YamlMap {
	const root: YamlMap = {};
	const stack: { indent: number; map: YamlMap }[] = [{ indent: -1, map: root }];
	for (const line of text.split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#") || line.trimStart().startsWith("- ")) continue;
		const indent = line.length - line.trimStart().length;
		const match = /^\s*('(?:[^']|'')*'|"[^"]*"|[^:]+?):(?:\s+(.*))?$/.exec(line);
		if (!match) continue;
		while (stack.at(-1)!.indent >= indent) stack.pop();
		const key = unquote(match[1]);
		const parent = stack.at(-1)!.map;
		if (match[2] === undefined || match[2] === "") {
			const child: YamlMap = {};
			parent[key] = child;
			stack.push({ indent, map: child });
		} else {
			parent[key] = match[2] === "{}" ? {} : unquote(match[2].trim());
		}
	}
	return root;
}

function unquote(value: string): string {
	if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
	if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
	return value;
}
