import type { Unresolved } from "./modules.ts";
import type { TestReport } from "./report.ts";

/**
 * Bookkeeping for a Tests run split into shards that run as separate queue messages: how many
 * shards are still out, and each finished shard's report. The shard that brings the count to
 * zero merges the reports and publishes the result.
 */

/** A queue message: some of a run's test files, to run in one Dynamic Worker. */
export interface TestShard {
	runId: number;
	/** Position in the shard tree: "3" is the fourth shard, "3.1" the second half of it after a split. */
	shard: string;
	/** "owner/repo" */
	repo: string;
	installationId: number;
	sha: string;
	/** Repository paths of the test files, e.g. "test/a.test.ts". */
	files: string[];
}

export interface ShardResult {
	report: TestReport;
	unresolved: Unresolved[];
}

export interface RunJob {
	checkRunId: number;
	installationId: number;
}

export interface JobStore {
	/** Records a run waiting on `shards` shards, reported on GitHub check run `checkRunId`. */
	create(runId: number, job: RunJob & { shards: number }): Promise<void>;
	get(runId: number): Promise<RunJob | null>;
	/**
	 * Replaces `shard` with `parts` shards. Returns false if it was already split, so a message
	 * delivered twice doesn't count its halves twice.
	 */
	split(runId: number, shard: string, parts: number): Promise<boolean>;
	/**
	 * Stores a shard's result. Returns every shard's results once this was the last one
	 * outstanding, otherwise null. A shard finishing twice counts once.
	 */
	finish(runId: number, shard: string, result: ShardResult): Promise<ShardResult[] | null>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS test_run_jobs (
	run_id INTEGER PRIMARY KEY,
	pending INTEGER NOT NULL,
	check_run_id INTEGER NOT NULL,
	installation_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS test_run_shards (
	run_id INTEGER NOT NULL,
	shard TEXT NOT NULL,
	result TEXT,
	PRIMARY KEY (run_id, shard)
)`;

/** A JobStore on D1, next to the test_runs history. Tables are created on first use. */
export function d1JobStore(db: D1Database): JobStore {
	let ready: Promise<unknown> | undefined;
	const schema = () => (ready ??= db.batch(SCHEMA.split(";").filter((s) => s.trim()).map((s) => db.prepare(s))));
	const changePending = (runId: number, delta: number) =>
		db.prepare("UPDATE test_run_jobs SET pending = pending + ? WHERE run_id = ? RETURNING pending").bind(delta, runId).first<{ pending: number }>();
	return {
		async create(runId, { shards, checkRunId, installationId }) {
			await schema();
			await db
				.prepare("INSERT INTO test_run_jobs (run_id, pending, check_run_id, installation_id) VALUES (?, ?, ?, ?)")
				.bind(runId, shards, checkRunId, installationId)
				.run();
		},
		async get(runId) {
			await schema();
			const row = await db
				.prepare("SELECT check_run_id, installation_id FROM test_run_jobs WHERE run_id = ?")
				.bind(runId)
				.first<{ check_run_id: number; installation_id: number }>();
			return row && { checkRunId: row.check_run_id, installationId: row.installation_id };
		},
		async split(runId, shard, parts) {
			await schema();
			// A split shard keeps a row without a result, which marks it as done.
			const { meta } = await db.prepare("INSERT OR IGNORE INTO test_run_shards (run_id, shard) VALUES (?, ?)").bind(runId, shard).run();
			if (!meta.changes) return false;
			await changePending(runId, parts - 1);
			return true;
		},
		async finish(runId, shard, result) {
			await schema();
			const { meta } = await db
				.prepare("INSERT OR IGNORE INTO test_run_shards (run_id, shard, result) VALUES (?, ?, ?)")
				.bind(runId, shard, JSON.stringify(result))
				.run();
			if (!meta.changes) return null;
			const row = await changePending(runId, -1);
			if (row?.pending !== 0) return null;
			const { results } = await db
				.prepare("SELECT result FROM test_run_shards WHERE run_id = ? AND result IS NOT NULL ORDER BY shard")
				.bind(runId)
				.all<{ result: string }>();
			return results.map((r) => JSON.parse(r.result) as ShardResult);
		},
	};
}
