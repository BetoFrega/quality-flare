// vitest reporter of the "Container tests" check (see qf-run.sh): keeps $OUT/progress.json up to date while the tests
// run, so TestBox (src/checks/tests/container.ts) shows how many passed and the failures before vitest finishes.
// Uses the reporter API of vitest 3 and later; with an older vitest the file never appears and the check shows less.
import { renameSync, writeFileSync } from "node:fs";

const OUT = process.env.OUT ?? "/work/out";
const ROOT = `${process.cwd()}/`;
/** Failures kept, and characters of each error: the check run summary has room for little more. */
const MAX_FAILURES = 20;
const MAX_ERROR = 1500;
/** At most one write this often; TestBox reads every 10 s. */
const WRITE_MS = 2000;

export default class QualityFlareProgress {
	progress = { files: 0, filesDone: 0, tests: 0, passed: 0, failed: 0, skipped: 0, broken: 0, failures: [] };
	timer = undefined;

	onTestRunStart(specifications) {
		this.progress.files = specifications.length;
		this.write();
	}

	onTestModuleCollected(testModule) {
		this.progress.tests += [...testModule.children.allTests()].length;
		this.schedule();
	}

	onTestCaseResult(testCase) {
		const { state, errors } = testCase.result();
		if (state === "passed") this.progress.passed++;
		else if (state === "failed") {
			this.progress.failed++;
			this.fail(testCase.module.moduleId, testCase.fullName, errors);
		} else this.progress.skipped++;
		this.schedule();
	}

	onTestModuleEnd(testModule) {
		this.progress.filesDone++;
		// A file that failed to load, or whose hook outside the tests threw.
		const errors = testModule.errors();
		if (errors.length) {
			this.progress.broken++;
			this.fail(testModule.moduleId, "", errors);
		}
		this.schedule();
	}

	onTestRunEnd() {
		clearTimeout(this.timer);
		this.write();
	}

	fail(file, name, errors = []) {
		if (this.progress.failures.length >= MAX_FAILURES) return;
		// vitest's own frames say nothing about the failure.
		const error = errors
			.map((e) => (e.stack || e.message || String(e)).split("\n").filter((line) => !line.includes("/node_modules/")).join("\n"))
			.join("\n")
			.slice(0, MAX_ERROR);
		this.progress.failures.push({ file: file.startsWith(ROOT) ? file.slice(ROOT.length) : file, name: name.replaceAll(" > ", " › "), error });
	}

	schedule() {
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			this.write();
		}, WRITE_MS);
	}

	/** Through a temporary file, so a read never sees half of it. */
	write() {
		try {
			writeFileSync(`${OUT}/progress.json.tmp`, JSON.stringify(this.progress));
			renameSync(`${OUT}/progress.json.tmp`, `${OUT}/progress.json`);
		} catch {
			// Progress is a nicety; the JSON report still decides the check.
		}
	}
}
