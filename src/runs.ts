import type { TestReport } from "./checks/tests/report.ts";
import type { CheckResult } from "./checks/types.ts";

/**
 * History of Tests check runs, kept in D1 for the admin: one row per run, inserted as
 * "running" when it starts and completed with the result and full report when it ends.
 */
export interface TestRun {
	id: number;
	/** "owner/repo" */
	repo: string;
	pr: number;
	sha: string;
	status: "running" | "completed";
	conclusion: CheckResult["conclusion"] | null;
	title: string | null;
	/** Epoch milliseconds. */
	startedAt: number;
	finishedAt: number | null;
}

export interface TestRunDetail extends TestRun {
	summary: string | null;
	report: TestReport | null;
}

export interface RunStore {
	start(run: { repo: string; pr: number; sha: string }): Promise<number>;
	finish(id: number, result: CheckResult, report?: TestReport): Promise<void>;
	/** Most recent first. */
	list(limit?: number): Promise<TestRun[]>;
	get(id: number): Promise<TestRunDetail | null>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS test_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repo TEXT NOT NULL,
	pr INTEGER NOT NULL,
	sha TEXT NOT NULL,
	status TEXT NOT NULL,
	conclusion TEXT,
	title TEXT,
	summary TEXT,
	report TEXT,
	started_at INTEGER NOT NULL,
	finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS test_runs_by_start ON test_runs (started_at DESC);`;

const COLUMNS = "id, repo, pr, sha, status, conclusion, title, started_at, finished_at";

interface Row {
	id: number;
	repo: string;
	pr: number;
	sha: string;
	status: TestRun["status"];
	conclusion: TestRun["conclusion"];
	title: string | null;
	started_at: number;
	finished_at: number | null;
	summary?: string | null;
	report?: string | null;
}

/** A RunStore on D1. The table is created on first use, so there is no migration step to run. */
export function d1RunStore(db: D1Database, now = () => Date.now()): RunStore {
	let ready: Promise<unknown> | undefined;
	const schema = () => (ready ??= db.batch(SCHEMA.split(";").filter((s) => s.trim()).map((s) => db.prepare(s))));
	return {
		async start({ repo, pr, sha }) {
			await schema();
			const row = await db
				.prepare("INSERT INTO test_runs (repo, pr, sha, status, started_at) VALUES (?, ?, ?, 'running', ?) RETURNING id")
				.bind(repo, pr, sha, now())
				.first<{ id: number }>();
			return row!.id;
		},
		async finish(id, result, report) {
			await schema();
			await db
				.prepare(
					"UPDATE test_runs SET status = 'completed', conclusion = ?, title = ?, summary = ?, report = ?, finished_at = ? WHERE id = ?",
				)
				.bind(result.conclusion, result.title, result.summary, report ? JSON.stringify(report) : null, now(), id)
				.run();
		},
		async list(limit = 50) {
			await schema();
			const { results } = await db.prepare(`SELECT ${COLUMNS} FROM test_runs ORDER BY started_at DESC, id DESC LIMIT ?`).bind(limit).all<Row>();
			return results.map(fromRow);
		},
		async get(id) {
			await schema();
			const row = await db.prepare(`SELECT ${COLUMNS}, summary, report FROM test_runs WHERE id = ?`).bind(id).first<Row>();
			return row ? { ...fromRow(row), summary: row.summary ?? null, report: row.report ? JSON.parse(row.report) : null } : null;
		},
	};
}

function fromRow(row: Row): TestRun {
	return {
		id: row.id,
		repo: row.repo,
		pr: row.pr,
		sha: row.sha,
		status: row.status,
		conclusion: row.conclusion,
		title: row.title,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}
