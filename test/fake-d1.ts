/** A D1Database backed by Node's built-in SQLite, for tests that run under Node. */
export async function fakeD1(): Promise<D1Database> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(":memory:");
	const statement = (sql: string, params: unknown[] = []) => ({
		bind: (...args: unknown[]) => statement(sql, args),
		first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
		all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
		run: async () => {
			db.prepare(sql).run(...(params as never[]));
			return { success: true };
		},
	});
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: { run(): Promise<unknown> }[]) => Promise.all(statements.map((s) => s.run())),
	} as unknown as D1Database;
}
