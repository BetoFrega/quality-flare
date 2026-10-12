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
import { getCurrentTest, startTests, type File, type Task, type Test, type VitestRunner } from "@vitest/runner";
import { clearAllMocks, fn, isMockFunction, resetAllMocks, restoreAllMocks, spyOn } from "@vitest/spy";
import type { TestReport, TestResult } from "../report.ts";

export {
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
	mock: unsupported("mock"),
	doMock: unsupported("doMock"),
	useFakeTimers: unsupported("useFakeTimers"),
};

class WorkerRunner implements VitestRunner {
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

	importFile(filepath: string) {
		return import(filepath);
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

/** Runs the given test files (module paths, e.g. "/test/a.test.ts") and reports every test. */
export async function runTests(paths: string[]): Promise<TestReport> {
	const files = await startTests(paths, new WorkerRunner());
	return { files: files.map(reportFile) };
}

function reportFile(file: File): TestReport["files"][number] {
	const tests: TestResult[] = [];
	const walk = (task: Task, prefix: string[]) => {
		const name = [...prefix, task.name];
		if (task.type === "suite") for (const child of task.tasks) walk(child, name);
		else tests.push({ name: name.join(" › "), state: task.result?.state ?? task.mode, errors: task.result?.errors?.map(formatError) });
	};
	for (const task of file.tasks) walk(task, []);
	return {
		path: file.filepath.replace(/^\//, ""),
		state: file.result?.state ?? "skip",
		errors: file.result?.errors?.map(formatError),
		tests,
	};
}

function formatError(error: { message?: string; stack?: string; diff?: string; name?: string }): string {
	const head = `${error.name ?? "Error"}: ${error.message ?? String(error)}`;
	return error.diff ? `${head}\n\n${error.diff}` : head;
}
