/**
 * What each Tests shard attempt cost, kept in D1 next to the run history for the admin: one row
 * per queue delivery of a shard. The consumer writes the row when the attempt starts and fills in
 * how it ended; the Dynamic Worker's Tail Worker (src/shard-tail.ts) adds its CPU and wall time.
 * An attempt whose row never got an outcome took the consumer down (out of memory, mostly).
 */

/** Identifies one delivery of a shard: `attempt` is the queue message's attempt number, from 1. */
export interface ShardAttempt {
	runId: number;
	shard: string;
	attempt: number;
}

/** How the consumer left a shard attempt (see processShard). */
export type ShardOutcome =
	/** Ran its files and stored the result. */
	| "ran"
	/** Ran, and queued its failed files to run again alone. */
	| "rechecked"
	/** Halved before running, because an earlier attempt took the consumer down. */
	| "split"
	/** The Dynamic Worker crashed; halved. */
	| "crashed"
	/** Its code didn't fit in a Dynamic Worker; halved. */
	| "too-large"
	/** Reported as failed without running: the run was past its deadline. */
	| "expired"
	/** Reported as failed without running: it took the consumer down too many times. */
	| "gave-up"
	/** Could not run (a download or build error); reported as failed. */
	| "failed"
	/** The run was cancelled or already over; nothing to do. */
	| "skipped"
	/** Threw in the consumer; the queue delivers it again. */
	| "error";

/** Dynamic Workers prices (https://developers.cloudflare.com/dynamic-workers/pricing/), in US dollars. */
export const PRICES = {
	/** Each Dynamic Worker created; `load()` without an id makes a new one every time. */
	dynamicWorker: 0.002,
	/** Per CPU millisecond (Workers Standard). */
	cpuMs: 0.02 / 1_000_000,
	/** Per Worker request: the consumer invocation and the Dynamic Worker fetch. */
	request: 0.3 / 1_000_000,
	/** Per Queues operation: each delivery reads and acks (or retries) a message that was written once. */
	queueOp: 0.4 / 1_000_000,
} as const;

/** Monthly allowances of the Workers Paid plan, shared by every Worker on the account. */
export const INCLUDED = { dynamicWorkers: 1_000, cpuMs: 30_000_000, requests: 10_000_000, queueOps: 1_000_000 } as const;

/** An attempt with no outcome after this long took the consumer down (shards stop after 5 minutes running). */
export const LOST_AFTER_MS = 15 * 60_000;

/** Sums over shard attempts: of one run, or of a day or month. */
export interface Usage {
	/** Queue deliveries of shards. */
	attempts: number;
	/** Deliveries after the first of a shard: each one follows a crash or an error. */
	retries: number;
	/** Attempts that took the consumer down (no outcome) or whose Dynamic Worker ran out of memory. */
	crashes: number;
	/** Attempts halved because they crashed, didn't fit, or followed a crash. */
	splits: number;
	dynamicWorkers: number;
	/** CPU of the Dynamic Workers, from their Tail Worker. The consumer's own CPU is not measured here. */
	cpuMs: number;
	/** Sum of the attempts' wall time in the consumer (they overlap, so this is more than the run took). */
	wallMs: number;
}

export interface UsageRow extends Usage {
	/** "2026-10-13" or "2026-10", UTC. */
	period: string;
	repo: string | null;
	runs: number;
}

export interface AttemptRow extends ShardAttempt {
	files: number | null;
	startedAt: number | null;
	finishedAt: number | null;
	outcome: ShardOutcome | null;
	codeBytes: number | null;
	dynamicWorker: boolean;
	cpuMs: number | null;
	dwWallMs: number | null;
	dwOutcome: string | null;
}

export interface MetricsStore {
	start(attempt: ShardAttempt & { files: number }): Promise<void>;
	finish(attempt: ShardAttempt & { outcome: ShardOutcome; codeBytes?: number; dynamicWorker: boolean }): Promise<void>;
	/** From the Tail Worker, once the Dynamic Worker's request is over. */
	trace(attempt: ShardAttempt & { cpuMs: number; wallMs: number; outcome: string }): Promise<void>;
	/** Per run, for the given runs; runs without attempts are absent. */
	byRun(runIds: number[]): Promise<Map<number, Usage>>;
	attempts(runId: number): Promise<AttemptRow[]>;
	/** Per UTC day or month since `since` (epoch milliseconds), per repository unless `repo` narrows it. */
	usage(by: "day" | "month", since: number, repo?: string): Promise<UsageRow[]>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS test_shard_attempts (
	run_id INTEGER NOT NULL,
	shard TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	files INTEGER,
	started_at INTEGER,
	finished_at INTEGER,
	outcome TEXT,
	code_bytes INTEGER,
	dynamic_worker INTEGER NOT NULL DEFAULT 0,
	dw_cpu_ms INTEGER,
	dw_wall_ms INTEGER,
	dw_outcome TEXT,
	PRIMARY KEY (run_id, shard, attempt)
);
CREATE INDEX IF NOT EXISTS test_shard_attempts_by_start ON test_shard_attempts (started_at)`;

/** SQL sums over test_shard_attempts `a` that make up a Usage. `?` is the cutoff for lost attempts. */
const USAGE = `COUNT(*) AS attempts,
	SUM(a.attempt > 1) AS retries,
	SUM((a.outcome IS NULL AND a.started_at < ?) OR a.dw_outcome = 'exceededMemory') AS crashes,
	SUM(a.outcome IN ('split', 'crashed', 'too-large')) AS splits,
	SUM(a.dynamic_worker) AS dynamic_workers,
	COALESCE(SUM(a.dw_cpu_ms), 0) AS cpu_ms,
	COALESCE(SUM(a.finished_at - a.started_at), 0) AS wall_ms`;

interface UsageSql {
	attempts: number;
	retries: number | null;
	crashes: number | null;
	splits: number | null;
	dynamic_workers: number | null;
	cpu_ms: number;
	wall_ms: number;
}

const usage = (r: UsageSql): Usage => ({
	attempts: r.attempts,
	retries: r.retries ?? 0,
	crashes: r.crashes ?? 0,
	splits: r.splits ?? 0,
	dynamicWorkers: r.dynamic_workers ?? 0,
	cpuMs: r.cpu_ms,
	wallMs: r.wall_ms,
});

/** A MetricsStore on D1. The table is created on first use, like the run history's. */
export function d1MetricsStore(db: D1Database, now = () => Date.now()): MetricsStore {
	let ready: Promise<unknown> | undefined;
	const schema = () => (ready ??= db.batch(SCHEMA.split(";").filter((s) => s.trim()).map((s) => db.prepare(s))));
	return {
		async start({ runId, shard, attempt, files }) {
			await schema();
			await db
				.prepare(
					`INSERT INTO test_shard_attempts (run_id, shard, attempt, files, started_at) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (run_id, shard, attempt) DO UPDATE SET files = excluded.files, started_at = excluded.started_at`,
				)
				.bind(runId, shard, attempt, files, now())
				.run();
		},
		async finish({ runId, shard, attempt, outcome, codeBytes, dynamicWorker }) {
			await schema();
			await db
				.prepare(
					`INSERT INTO test_shard_attempts (run_id, shard, attempt, finished_at, outcome, code_bytes, dynamic_worker) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (run_id, shard, attempt) DO UPDATE SET finished_at = excluded.finished_at, outcome = excluded.outcome,
						code_bytes = excluded.code_bytes, dynamic_worker = excluded.dynamic_worker`,
				)
				.bind(runId, shard, attempt, now(), outcome, codeBytes ?? null, dynamicWorker ? 1 : 0)
				.run();
		},
		async trace({ runId, shard, attempt, cpuMs, wallMs, outcome }) {
			await schema();
			await db
				.prepare(
					`INSERT INTO test_shard_attempts (run_id, shard, attempt, dynamic_worker, dw_cpu_ms, dw_wall_ms, dw_outcome) VALUES (?, ?, ?, 1, ?, ?, ?)
					ON CONFLICT (run_id, shard, attempt) DO UPDATE SET dynamic_worker = 1,
						dw_cpu_ms = COALESCE(dw_cpu_ms, 0) + excluded.dw_cpu_ms, dw_wall_ms = COALESCE(dw_wall_ms, 0) + excluded.dw_wall_ms,
						dw_outcome = excluded.dw_outcome`,
				)
				.bind(runId, shard, attempt, Math.round(cpuMs), Math.round(wallMs), outcome)
				.run();
		},
		async byRun(runIds) {
			const result = new Map<number, Usage>();
			if (!runIds.length) return result;
			await schema();
			const { results } = await db
				.prepare(
					`SELECT a.run_id, ${USAGE} FROM test_shard_attempts a WHERE a.run_id IN (${runIds.map(() => "?").join(", ")}) GROUP BY a.run_id`,
				)
				.bind(now() - LOST_AFTER_MS, ...runIds)
				.all<UsageSql & { run_id: number }>();
			for (const r of results) result.set(r.run_id, usage(r));
			return result;
		},
		async attempts(runId) {
			await schema();
			const { results } = await db
				.prepare("SELECT * FROM test_shard_attempts WHERE run_id = ? ORDER BY started_at IS NULL, started_at, shard, attempt")
				.bind(runId)
				.all<Record<string, number | string | null>>();
			return results.map((r) => ({
				runId: r.run_id as number,
				shard: r.shard as string,
				attempt: r.attempt as number,
				files: r.files as number | null,
				startedAt: r.started_at as number | null,
				finishedAt: r.finished_at as number | null,
				outcome: r.outcome as ShardOutcome | null,
				codeBytes: r.code_bytes as number | null,
				dynamicWorker: Boolean(r.dynamic_worker),
				cpuMs: r.dw_cpu_ms as number | null,
				dwWallMs: r.dw_wall_ms as number | null,
				dwOutcome: r.dw_outcome as string | null,
			}));
		},
		async usage(by, since, repo) {
			await schema();
			// Attempts the Tail Worker recorded alone have no start; their run's start dates them.
			const at = "COALESCE(a.started_at, r.started_at)";
			const period = `strftime('${by === "day" ? "%Y-%m-%d" : "%Y-%m"}', ${at} / 1000, 'unixepoch')`;
			const { results } = await db
				.prepare(
					`SELECT ${period} AS period, ${repo ? "r.repo" : "NULL"} AS repo, COUNT(DISTINCT a.run_id) AS runs, ${USAGE}
					FROM test_shard_attempts a JOIN test_runs r ON r.id = a.run_id
					WHERE ${at} >= ?${repo ? " AND r.repo = ?" : ""}
					GROUP BY period ORDER BY period DESC`,
				)
				.bind(now() - LOST_AFTER_MS, since, ...(repo ? [repo] : []))
				.all<UsageSql & { period: string; repo: string | null; runs: number }>();
			return results.map((r) => ({ period: r.period, repo: r.repo, runs: r.runs, ...usage(r) }));
		},
	};
}

/** What the usage would cost on its own, before the plan's monthly allowances. */
export function cost(u: Usage): number {
	return (
		u.dynamicWorkers * PRICES.dynamicWorker +
		u.cpuMs * PRICES.cpuMs +
		(u.attempts + u.dynamicWorkers) * PRICES.request +
		// Each delivery reads the message and acks or retries it; each shard was written once.
		u.attempts * 3 * PRICES.queueOp
	);
}

/** A month's cost after the plan's allowances, as if nothing else on the account used them. */
export function monthCost(u: Usage): number {
	const over = (used: number, included: number) => Math.max(0, used - included);
	return (
		over(u.dynamicWorkers, INCLUDED.dynamicWorkers) * PRICES.dynamicWorker +
		over(u.cpuMs, INCLUDED.cpuMs) * PRICES.cpuMs +
		over(u.attempts + u.dynamicWorkers, INCLUDED.requests) * PRICES.request +
		over(u.attempts * 3, INCLUDED.queueOps) * PRICES.queueOp
	);
}
