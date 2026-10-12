/**
 * `vi.mock` at run time. The bundle (see ../mocks.ts) moves each test file's `vi.mock` calls into
 * a module evaluated before it, and imports of a mocked module go to a facade instead. Each facade
 * has `let` bindings that this module points, per test file, at the factory's result or at the real
 * module: before a file is imported (collection) and again before its tests run, since every file
 * is collected before any test runs.
 */

type Namespace = Record<string, unknown>;
type Factory = ((importOriginal: () => Promise<unknown>) => unknown) | undefined;

/** What the bundle knows about one test file (or setup file). */
export interface FileEntry {
	/** The module holding the file's hoisted `vi.mock`/`vi.hoisted` calls. */
	mocks?: string;
	/** Mocked modules the file may import, in an order that puts dependencies first. */
	reach: string[];
	/** vitest's environment: "node" when absent. */
	environment?: string;
	/** Setup file → this file's own copy of it, so its top-level code runs again for each file. */
	setup?: Record<string, string>;
}

/** Written by the bundle; a variable, so the runtime's bundler leaves the import alone. */
const REGISTRY_MODULE: string = "/__qf/files.js";
let registry: Promise<Record<string, FileEntry>> | undefined;

/** The bundle's entry for a file; undefined for a bundle without one. */
export async function fileEntry(file: string): Promise<FileEntry | undefined> {
	registry ??= import(REGISTRY_MODULE).then((m: { default: Record<string, FileEntry> }) => m.default, () => ({}));
	return (await registry)[file];
}

const facades = new Map<string, (ns: Namespace) => void>();
const prepared = new Map<string, Map<string, Namespace | Error>>();
let current = new Map<string, Namespace | Error>();
let registering: Map<string, Factory> | undefined;

/** Called by each facade as it is evaluated, with a function that repoints its bindings. */
export function mockFacade(key: string, apply: (ns: Namespace) => void): void {
	facades.set(key, apply);
	const value = current.get(key);
	if (value instanceof Error) throw value;
	if (value) apply(value);
}

/** `vi.mock(key, factory)` as the bundle rewrote it: `key` is the mocked module's name in the bundle. */
export function mock(key: string, factory?: Factory): void {
	if (!registering) throw new Error("vi.mock() só é suportado no topo do arquivo de teste, fora de funções e blocos.");
	registering.set(key, factory);
}

/** Evaluates a file's mocks and the real modules it may import, before the file is imported. */
export async function prepareMocks(file: string, entry: FileEntry): Promise<void> {
	const factories = new Map<string, Factory>();
	registering = factories;
	try {
		if (entry.mocks) await import(entry.mocks);
	} finally {
		registering = undefined;
	}
	const values = new Map<string, Namespace | Error>();
	prepared.set(file, values);
	current = values;
	for (const key of entry.reach) {
		let value: Namespace | Error;
		try {
			value = factories.has(key) ? await fromFactory(key, factories.get(key)) : await import(key);
		} catch (error) {
			value = error instanceof Error ? error : new Error(String(error));
		}
		values.set(key, value);
		if (!(value instanceof Error)) facades.get(key)?.(value);
	}
}

/** Points every facade at what `file` sees, before its tests run. */
export function activateMocks(file: string): void {
	const values = prepared.get(file);
	if (values) activate(values);
}

function activate(values: Map<string, Namespace | Error>) {
	current = values;
	for (const [key, apply] of facades) {
		const value = values.get(key);
		if (value && !(value instanceof Error)) apply(value);
	}
}

async function fromFactory(key: string, factory: Factory): Promise<Namespace> {
	if (!factory) throw new Error(`vi.mock("${key}") sem factory (automock ou pasta __mocks__) não é suportado no quality-flare; passe uma factory.`);
	const value = await factory(() => import(key));
	if (value === null || typeof value !== "object") {
		throw new Error(`A factory de vi.mock("${key}") deve retornar um objeto com os exports do módulo.`);
	}
	return value as Namespace;
}
