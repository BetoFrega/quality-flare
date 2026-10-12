import { importSpecifiers, packageFileOf } from "./modules.ts";
import { walkTarball } from "./tarball.ts";

/** An npm package's files, keyed by their path inside the package. A Map holds them all at once. */
export interface PackageFiles {
	has(path: string): boolean;
	/** The text of a file, once loaded. */
	get(path: string): string | undefined;
	/** Loads files before `get`; absent when every file is already in memory. */
	load?(paths: string[]): Promise<void>;
}

// Every package.json stays: a folder's "main" decides what importing the folder loads.
const isPackageJson = (path: string) => path === "package.json" || path.endsWith("/package.json");

/**
 * Tarball passes running at once in this isolate, which concurrent queue invocations share. A
 * Worker keeps 6 connections open; past that, the runtime may cancel a stream left waiting.
 */
const MAX_PASSES = 4;
let running = 0;
const waiting: (() => void)[] = [];

/** Runs `pass` once fewer than MAX_PASSES are running. */
async function inTurn<T>(pass: () => Promise<T>): Promise<T> {
	// A finishing pass hands its slot straight to the next one waiting.
	if (running < MAX_PASSES) running++;
	else await new Promise<void>((resolve) => waiting.push(resolve));
	try {
		return await pass();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else running--;
	}
}

/** Text kept per package before it switches to loading files on demand. */
export const EAGER_PACKAGE_CHARS = 8 * 1024 * 1024;

/**
 * Reads a package tarball. Small packages are kept whole. Past `budget` characters (`next`
 * unpacks to ~186 MB, beyond a Worker's 128 MB) only the package.json files, the file list and each
 * module's import specifiers stay; files are read from a fresh download of the tarball when
 * the bundle asks for them.
 */
export async function readPackage(
	download: () => Promise<ReadableStream<Uint8Array>>,
	isPackageFile: (path: string) => boolean,
	budget = EAGER_PACKAGE_CHARS,
): Promise<PackageFiles> {
	const paths = new Set<string>();
	const files = new Map<string, string>();
	const imports = new Map<string, string[]>();
	let size = 0;
	let lazy = false;
	const index = (path: string, text: string) => {
		// A copy: V8 keeps a whole file's text alive behind any substring of it.
		if (!path.endsWith(".json")) imports.set(path, JSON.parse(JSON.stringify(importSpecifiers(text))));
	};
	await inTurn(async () => walkTarball(await download(), (path) => {
		if (!isPackageFile(path)) return undefined;
		paths.add(path);
		return (text) => {
			if (lazy && !isPackageJson(path)) return index(path, text);
			files.set(path, text);
			size += text.length;
			if (lazy || size <= budget) return;
			lazy = true;
			for (const [kept, keptText] of files) {
				if (isPackageJson(kept)) continue;
				index(kept, keptText);
				files.delete(kept);
			}
		};
	}));
	return lazy ? onDemand(paths, files, imports, download) : files;
}

/**
 * Files read on demand. A request brings the file and everything it reaches inside the package,
 * which the bundle follows anyway, and requests made while the bundle resolves one
 * wave of imports share one pass over the tarball. A pass stops once it has found them all.
 */
function onDemand(
	paths: Set<string>,
	files: Map<string, string>,
	imports: Map<string, string[]>,
	download: () => Promise<ReadableStream<Uint8Array>>,
): PackageFiles {
	const requested = new Map<string, Promise<void>>();
	let batch: Set<string> | undefined;
	let pass: Promise<void> | undefined;
	const exists = (path: string) => paths.has(path);
	const json = JSON.parse(files.get("package.json") ?? "{}") as { name?: string; exports?: unknown };
	const self = json.exports ? undefined : json.name;
	const read = async (wanted: Set<string>) => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		batch = undefined;
		let found = 0;
		await inTurn(async () => walkTarball(
			await download(),
			(path) =>
				wanted.has(path)
					? (text) => {
							files.set(path, text);
							found++;
						}
					: undefined,
			() => found === wanted.size,
		));
	};
	const request = (path: string, waits: Set<Promise<void>>) => {
		let wait = requested.get(path);
		if (!wait) {
			if (!batch) {
				batch = new Set();
				pass = read(batch);
			}
			batch.add(path);
			wait = pass!;
			requested.set(path, wait);
			for (const specifier of imports.get(path) ?? []) {
				const file = packageFileOf(path, specifier, exists, (p) => files.get(p), self);
				if (file && !files.has(file)) request(file, waits);
			}
		}
		waits.add(wait);
	};
	return {
		has: exists,
		get: (path) => files.get(path),
		async load(wanted) {
			const waits = new Set<Promise<void>>();
			for (const path of wanted) if (paths.has(path) && !files.has(path)) request(path, waits);
			await Promise.all(waits);
		},
	};
}
