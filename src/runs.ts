import type { TestReport } from "./checks/tests/report.ts";
import type { CheckResult, Conclusion } from "./checks/types.ts";

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
	conclusion: Conclusion | null;
	title: string | null;
	/** Epoch milliseconds. */
	startedAt: number;
	finishedAt: number | null;
	/** A run of the Container tests check (it has a test_container_runs row); otherwise of Tests. */
	container?: boolean;
}

export interface TestRunDetail extends TestRun {
	summary: string | null;
	report: TestReport | null;
}

export interface RunStore {
	/** `container` marks a run of the Container tests check, which a Tests run never cancels, nor the other way round. */
	start(run: { repo: string; pr: number; sha: string; container?: boolean }): Promise<number>;
	/** Ids of the PR's runs still running, other than `except`, of the same check as `except`. */
	running(repo: string, pr: number, except: number): Promise<number[]>;
	/** Whether the PR (0 for full runs) already has a run of the commit, of either check. */
	ran(repo: string, pr: number, sha: string): Promise<boolean>;
	/** Runs still running that started before `startedBefore` (epoch milliseconds). */
	overdue(startedBefore: number): Promise<{ id: number; repo: string }[]>;
	finish(id: number, result: CheckResult, report?: TestReport): Promise<void>;
	/** Most recent first, unless the query sorts otherwise. */
	list(query?: RunQuery): Promise<TestRun[]>;
	/** Every repository with a recorded run, by name. */
	repos(): Promise<string[]>;
	get(id: number): Promise<TestRunDetail | null>;
}

/** A run still "running" after this long, past its deadline (RUN_DEADLINE_MS), was cut off and will never finish. */
export const STALE_AFTER_MS = 75 * 60_000;

/** What the admin shows for a run: its conclusion, or whether it is still running or was cut off. */
export type RunState = Conclusion | "running" | "stale";
export const RUN_STATES: RunState[] = ["success", "failure", "neutral", "cancelled", "running", "stale"];

export type RunSort = "recent" | "oldest" | "longest" | "shortest";
export const RUN_SORTS: RunSort[] = ["recent", "oldest", "longest", "shortest"];

export interface RunQuery {
	repo?: string;
	state?: RunState;
	sort?: RunSort;
	limit?: number;
}

export function runState(run: Pick<TestRun, "status" | "conclusion" | "startedAt">, now: number): RunState {
	if (run.status === "running") return now - run.startedAt > STALE_AFTER_MS ? "stale" : "running";
	return run.conclusion ?? "neutral";
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
CREATE INDEX IF NOT EXISTS test_runs_by_start ON test_runs (started_at DESC);
CREATE TABLE IF NOT EXISTS test_container_runs (
	run_id INTEGER PRIMARY KEY,
	instance TEXT,
	wall_ms INTEGER,
	cpu_us INTEGER
);`;

const COLUMNS = "id, repo, pr, sha, status, conclusion, title, started_at, finished_at, id IN (SELECT run_id FROM test_container_runs) AS container";

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
	container: number;
	summary?: string | null;
	report?: string | null;
}

/** A RunStore on D1. The table is created on first use, so there is no migration step to run. */
export function d1RunStore(db: D1Database, now = () => Date.now()): RunStore {
	let ready: Promise<unknown> | undefined;
	const schema = () => (ready ??= db.batch(SCHEMA.split(";").filter((s) => s.trim()).map((s) => db.prepare(s))));
	return {
		async start({ repo, pr, sha, container }) {
			await schema();
			const row = await db
				.prepare("INSERT INTO test_runs (repo, pr, sha, status, started_at) VALUES (?, ?, ?, 'running', ?) RETURNING id")
				.bind(repo, pr, sha, now())
				.first<{ id: number }>();
			if (container) await db.prepare("INSERT INTO test_container_runs (run_id) VALUES (?)").bind(row!.id).run();
			return row!.id;
		},
		async running(repo, pr, except) {
			await schema();
			const container = "(SELECT run_id FROM test_container_runs)";
			const { results } = await db
				.prepare(
					`SELECT id FROM test_runs WHERE repo = ? AND pr = ? AND status = 'running' AND id != ?
					AND (id IN ${container}) = (? IN ${container})`,
				)
				.bind(repo, pr, except, except)
				.all<{ id: number }>();
			return results.map((r) => r.id);
		},
		async ran(repo, pr, sha) {
			await schema();
			return Boolean(await db.prepare("SELECT 1 FROM test_runs WHERE repo = ? AND pr = ? AND sha = ? LIMIT 1").bind(repo, pr, sha).first());
		},
		async overdue(startedBefore) {
			await schema();
			const { results } = await db
				.prepare("SELECT id, repo FROM test_runs WHERE status = 'running' AND started_at < ?")
				.bind(startedBefore)
				.all<{ id: number; repo: string }>();
			return results;
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
		async list({ repo, state, sort = "recent", limit = 50 } = {}) {
			await schema();
			const at = now();
			const where: string[] = [];
			const params: unknown[] = [];
			if (repo) {
				where.push("repo = ?");
				params.push(repo);
			}
			if (state === "running" || state === "stale") {
				where.push(`status = 'running' AND started_at ${state === "stale" ? "<" : ">="} ?`);
				params.push(at - STALE_AFTER_MS);
			} else if (state === "neutral") {
				where.push("status = 'completed' AND (conclusion = 'neutral' OR conclusion IS NULL)");
			} else if (state) {
				where.push("status = 'completed' AND conclusion = ?");
				params.push(state);
			}
			// Runs cut off never ended, so they have no duration: they sort last either way.
			const duration = `CASE WHEN status = 'running' AND started_at < ${at - STALE_AFTER_MS} THEN NULL ELSE COALESCE(finished_at, ${at}) - started_at END`;
			const order = {
				recent: "started_at DESC, id DESC",
				oldest: "started_at ASC, id ASC",
				longest: `${duration} IS NULL, ${duration} DESC, id DESC`,
				shortest: `${duration} IS NULL, ${duration} ASC, id DESC`,
			}[sort];
			const { results } = await db
				.prepare(`SELECT ${COLUMNS} FROM test_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`)
				.bind(...params, limit)
				.all<Row>();
			return results.map(fromRow);
		},
		async repos() {
			await schema();
			const { results } = await db.prepare("SELECT DISTINCT repo FROM test_runs ORDER BY repo").all<{ repo: string }>();
			return results.map((r) => r.repo);
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
		container: Boolean(row.container),
	};
}
