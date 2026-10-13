import type { Weights } from "./modules.ts";

/**
 * The weights measured for each test file when its shard last built (see `Weights`), kept in D1
 * so the next run packs shards by size (`packFiles`).
 */
export interface WeightStore {
	/** The repository's test files with a measurement, by path. */
	get(repo: string): Promise<Map<string, Weights>>;
	put(repo: string, weights: Record<string, Weights>): Promise<void>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS test_file_weights (
	repo TEXT NOT NULL,
	path TEXT NOT NULL,
	weights TEXT NOT NULL,
	measured_at INTEGER NOT NULL,
	PRIMARY KEY (repo, path)
)`;

/** A WeightStore on D1, next to the test_runs history. The table is created on first use. */
export function d1WeightStore(db: D1Database, now = () => Date.now()): WeightStore {
	let ready: Promise<unknown> | undefined;
	const schema = () => (ready ??= db.prepare(SCHEMA).run());
	return {
		async get(repo) {
			await schema();
			const { results } = await db.prepare("SELECT path, weights FROM test_file_weights WHERE repo = ?").bind(repo).all<{ path: string; weights: string }>();
			return new Map(results.map((row) => [row.path, JSON.parse(row.weights) as Weights]));
		},
		async put(repo, weights) {
			const entries = Object.entries(weights);
			if (!entries.length) return;
			await schema();
			const upsert = db.prepare(
				`INSERT INTO test_file_weights (repo, path, weights, measured_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (repo, path) DO UPDATE SET weights = excluded.weights, measured_at = excluded.measured_at`,
			);
			await db.batch(entries.map(([path, w]) => upsert.bind(repo, path, JSON.stringify(w), now())));
		},
	};
}
