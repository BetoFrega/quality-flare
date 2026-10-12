/**
 * The test runtime loaded into each Dynamic Worker. It is bundled at build time (see
 * build/test-runtime.ts) and is both the `vitest` module test files import and the
 * runner that collects and runs them, built on @vitest/runner and @vitest/expect.
 */
import {
	ASYMMETRIC_MATCHERS_OBJECT,
	ChaiStyleAssertions,
	GLOBAL_EXPECT,
	JestAsymmetricMatchers,
	JestChaiExpect,
	JestExtend,
	addCustomEqualityTesters,
	chai,
	getState,
	setState,
	type ExpectStatic,
	type MatcherState,
} from "@vitest/expect";
import { getCurrentTest, startTests, type File, type Suite, type Task, type Test, type VitestRunner } from "@vitest/runner";
import { clearAllMocks, fn, isMockFunction, resetAllMocks, restoreAllMocks, spyOn } from "@vitest/spy";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	it,
	onTestFailed,
	onTestFinished,
	suite,
	test,
} from "@vitest/runner";
import type { ProgressEvent, RunRequest, TestReport, TestResult } from "../report.ts";
import { activateEnvironment, setUpEnvironment } from "./environment.ts";
import { activateMocks, fileEntry, mock, mockFacade, prepareMocks } from "./mocks.ts";
import { loadTimers, timers } from "./timers.ts";

export { mockFacade };
export { afterAll, afterEach, beforeAll, beforeEach, describe, it, onTestFailed, onTestFinished, suite, test };

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(ChaiStyleAssertions);
chai.use(JestAsymmetricMatchers);

const freshState = (testName: string): Partial<MatcherState> => ({
	assertionCalls: 0,
	isExpectingAssertions: false,
	isExpectingAssertionsError: null,
	expectedAssertionsNumber: null,
	expectedAssertionsNumberErrorGen: null,
	currentTestName: testName,
});

/** vitest adds these members to ExpectStatic itself; @vitest/expect's type doesn't declare them. */
type RuntimeExpect = ExpectStatic & Record<string, any>;

/** Mirrors vitest's own createExpect, minus snapshots and expect.poll. */
function createExpect(test?: Test): RuntimeExpect {
	const expect = ((value: unknown, message?: string) => {
		const { assertionCalls } = getState(expect);
		setState({ assertionCalls: assertionCalls + 1 }, expect);
		const assertion = chai.expect(value, message) as unknown as { withTest(t: Test): unknown };
		const current = test ?? getCurrentTest();
		return current ? assertion.withTest(current) : assertion;
	}) as RuntimeExpect;
	Object.assign(expect, chai.expect);
	Object.assign(expect, (globalThis as Record<symbol, object>)[ASYMMETRIC_MATCHERS_OBJECT]);
	expect.getState = () => getState(expect);
	expect.setState = (state) => setState(state, expect);
	setState(freshState(test?.fullTestName ?? ""), expect);
	expect.assert = chai.assert;
	expect.extend = (matchers: Parameters<ExpectStatic["extend"]>[0]) => (chai.expect as unknown as { extend(e: unknown, m: unknown): void }).extend(expect, matchers);
	expect.addEqualityTesters = (testers: Parameters<typeof addCustomEqualityTesters>[0]) => addCustomEqualityTesters(testers);
	expect.soft = (...args: Parameters<ExpectStatic>) =>
		(expect(...args) as unknown as { withContext(c: object): ReturnType<ExpectStatic> }).withContext({ soft: true });
	expect.unreachable = (message?: string) => {
		chai.assert.fail(`expected${message ? ` "${message}" ` : " "}not to be reached`);
	};
	expect.assertions = (expected: number) => {
		const errorGen = () =>
			new Error(`expected number of assertions to be ${expected}, but got ${expect.getState().assertionCalls}`);
		expect.setState({ expectedAssertionsNumber: expected, expectedAssertionsNumberErrorGen: errorGen });
	};
	expect.hasAssertions = () => {
		expect.setState({ isExpectingAssertions: true, isExpectingAssertionsError: new Error("expected any number of assertion, but got none") });
	};
	return expect;
}

export const expect = createExpect();
(globalThis as Record<symbol, unknown>)[GLOBAL_EXPECT] = expect;

const stubbedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const stubbedEnv = new Map<string, string | undefined>();
/** vi.resetModules() calls in the current file: which fresh copy its dynamic imports load (see modules.ts). */
let resets = 0;
(globalThis as Record<string, unknown>).__qf_fresh = (target: string, copies: number) => `/__qf/fresh/${Math.min(resets, copies - 1)}${target}`;
const env = () => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const unsupported = (name: string) => () => {
	throw new Error(`vi.${name}() não é suportado ao rodar testes no quality-flare.`);
};

/** The subset of `vi` that works without vitest's module graph: spies and global stubs. */
export const vi = {
	fn,
	spyOn,
	isMockFunction,
	clearAllMocks,
	resetAllMocks,
	restoreAllMocks,
	mocked: <T>(value: T) => value,
	stubGlobal(name: PropertyKey, value: unknown) {
		if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
		return vi;
	},
	unstubAllGlobals() {
		for (const [name, original] of stubbedGlobals) {
			if (original) Object.defineProperty(globalThis, name, original);
			else delete (globalThis as Record<PropertyKey, unknown>)[name];
		}
		stubbedGlobals.clear();
		return vi;
	},
	stubEnv(name: string, value: string | boolean | undefined) {
		const vars = env();
		if (!stubbedEnv.has(name)) stubbedEnv.set(name, vars[name]);
		if (value === undefined) delete vars[name];
		else vars[name] = typeof value === "boolean" ? (value ? "1" : "") : value;
		return vi;
	},
	unstubAllEnvs() {
		const vars = env();
		for (const [name, original] of stubbedEnv) {
			if (original === undefined) delete vars[name];
			else vars[name] = original;
		}
		stubbedEnv.clear();
		return vi;
	},
	async waitFor<T>(callback: () => T | Promise<T>, options: number | { timeout?: number; interval?: number } = {}) {
		const { timeout = 1000, interval = 50 } = typeof options === "number" ? { timeout: options } : options;
		const deadline = Date.now() + timeout;
		for (;;) {
			try {
				return await callback();
			} catch (error) {
				if (Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, interval));
			}
		}
	},
	async waitUntil<T>(callback: () => T | Promise<T>, options: number | { timeout?: number; interval?: number } = {}) {
		return vi.waitFor(async () => {
			const value = await callback();
			if (!value) throw new Error("vi.waitUntil: a condição não ficou verdadeira a tempo.");
			return value;
		}, options);
	},
	mock,
	hoisted: <T>(factory: () => T): T => factory(),
	importActual: unsupported("importActual com especificador que não é um texto literal"),
	doMock: unsupported("doMock"),
	unmock: unsupported("unmock"),
	resetModules() {
		resets++;
		return vi;
	},
};
// vi.useFakeTimers(), vi.advanceTimersByTime()… return vi, as in vitest, so calls chain.
for (const [name, method] of Object.entries(timers)) {
	(vi as Record<string, unknown>)[name] = (...args: unknown[]) => {
		const result = (method as (...a: unknown[]) => unknown)(...args);
		if (result instanceof Promise) return result.then(() => vi);
		return result === undefined ? vi : result;
	};
}

class WorkerRunner implements VitestRunner {
	constructor(
		private readonly onProgress: (event: ProgressEvent) => void,
		options: Omit<RunRequest, "files" | "globals"> = {},
	) {
		this.config.setupFiles = options.setupFiles ?? [];
		if (options.testTimeout) this.config.testTimeout = options.testTimeout;
	}

	config: VitestRunner["config"] = {
		root: "/",
		setupFiles: [],
		name: undefined,
		passWithNoTests: false,
		testNamePattern: undefined,
		allowOnly: false,
		sequence: { seed: 0, hooks: "stack", setupFiles: "list" },
		chaiConfig: undefined,
		maxConcurrency: 5,
		testTimeout: 5_000,
		hookTimeout: 10_000,
		retry: 0,
		includeTaskLocation: false,
		tags: [],
		tagsFilter: undefined,
		strictTags: false,
	};

	/** The test file being collected: setup files run in its environment, with its mocks. */
	private collecting = "";
	private readonly ready = new Set<string>();

	onCollectStart(file: File) {
		this.collecting = file.filepath;
		timers.useRealTimers();
		resets = 0;
	}

	async importFile(filepath: string, source: "collect" | "setup") {
		const file = source === "setup" ? this.collecting : filepath;
		const entry = await fileEntry(file);
		if (!this.ready.has(file)) {
			this.ready.add(file);
			await setUpEnvironment(file, entry?.environment);
			if (entry) await prepareMocks(file, entry);
		}
		return import(source === "setup" ? (entry?.setup?.[filepath] ?? filepath) : filepath);
	}

	onBeforeRunSuite(suite: Suite) {
		// Every file is collected before any test runs: bring back this file's environment and mocks.
		if ("filepath" in suite) {
			const file = (suite as File).filepath;
			// Fake timers end with the file that installed them, as in vitest.
			timers.useRealTimers();
			resets = 0;
			activateEnvironment(file);
			activateMocks(file);
		}
	}

	onCollected(files: File[]) {
		this.onProgress({ type: "collected", total: files.reduce((n, f) => n + countTests(f), 0) });
	}

	onAfterRunTask(test: Test) {
		this.onProgress({ type: "test", file: path(test.file), ...testResult(test, testName(test)) });
	}

	onBeforeTryTask(test: Test) {
		setState(freshState(test.fullTestName ?? test.name), expect);
	}

	onAfterTryTask() {
		const state = getState(expect);
		if (state.expectedAssertionsNumber !== null && state.assertionCalls !== state.expectedAssertionsNumber) {
			throw state.expectedAssertionsNumberErrorGen!();
		}
		if (state.isExpectingAssertions && state.assertionCalls === 0) throw state.isExpectingAssertionsError;
	}

	extendTaskContext(context: Parameters<NonNullable<VitestRunner["extendTaskContext"]>>[0]) {
		let local: RuntimeExpect | undefined;
		Object.defineProperty(context, "expect", { get: () => (local ??= createExpect(context.task)) });
		return context;
	}
}

/** What vitest's `globals: true` exposes. */
const GLOBALS = { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, onTestFinished, suite, test, vi };

/**
 * workerd defines some APIs only to throw "not implemented". Libraries that check for them
 * before use (React's dev build calls console.createTask when it exists) then fail; without
 * them, they take their fallback, as they would on a runtime that lacks the API.
 */
function hideUnimplemented() {
	const console = (globalThis as unknown as { console: { createTask?: (name: string) => unknown } }).console;
	try {
		console.createTask?.("quality-flare");
	} catch {
		console.createTask = undefined;
	}
}

/** Runs the given test files (module paths, e.g. "/test/a.test.ts") and reports every test. */
export async function runTests(run: RunRequest | string[], onProgress: (event: ProgressEvent) => void = () => {}): Promise<TestReport> {
	const { files: paths, globals, ...options } = Array.isArray(run) ? { files: run } : run;
	if (globals) Object.assign(globalThis, GLOBALS);
	await loadTimers();
	hideUnimplemented();
	const files = await startTests(paths, new WorkerRunner(onProgress, options));
	return { files: files.map(reportFile) };
}

/**
 * The Dynamic Worker's entry point: runs the files posted as a JSON array and streams
 * newline-delimited JSON back: progress events as tests finish, then `{ type: "report" }`.
 */
export function handleRequest(request: Request): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const send = (event: object) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
	(async () => {
		try {
			const report = await runTests(await request.json(), send);
			await send({ type: "report", report });
		} catch (error) {
			await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			await writer.close().catch(() => {});
		}
	})();
	return new Response(readable, { headers: { "Content-Type": "application/x-ndjson" } });
}

function reportFile(file: File): TestReport["files"][number] {
	const tests: TestResult[] = [];
	const walk = (task: Task, prefix: string[]) => {
		const name = [...prefix, task.name];
		if (task.type === "suite") for (const child of task.tasks) walk(child, name);
		else tests.push(testResult(task, name.join(" › ")));
	};
	for (const task of file.tasks) walk(task, []);
	return { path: path(file), state: file.result?.state ?? "skip", errors: file.result?.errors?.map(formatError), tests };
}

function testResult(task: Task, name: string): TestResult {
	return { name, state: task.result?.state ?? task.mode, errors: task.result?.errors?.map(formatError) };
}

const path = (file: File) => file.filepath.replace(/^\//, "");

/** "suite › nested › test", the same name the final report uses. */
function testName(test: Test): string {
	const names = [test.name];
	for (let suite = test.suite; suite && suite !== test.file; suite = suite.suite) names.unshift(suite.name);
	return names.join(" › ");
}

function countTests(task: Task): number {
	return task.type === "suite" ? task.tasks.reduce((n, t) => n + countTests(t), 0) : 1;
}

function formatError(error: { message?: string; stack?: string; diff?: string; name?: string }): string {
	const head = `${error.name ?? "Error"}: ${error.message ?? String(error)}`;
	return error.diff ? `${head}\n\n${error.diff}` : head;
}
