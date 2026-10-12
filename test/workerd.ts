/**
 * Runs a Worker on the real workerd binary for integration tests (Node only).
 * `modules` are written next to the config; `worker` is the rest of the Worker's capnp
 * struct (bindings, Durable Object namespaces…).
 */
export async function serveWorkerd(modules: Record<string, string>, worker: string): Promise<{ url: string; stop(): Promise<void> }> {
	const [{ spawn }, { mkdtemp, writeFile, rm }, { tmpdir }, { join }, { createServer }, { createRequire }] = await Promise.all([
		import("node:child_process"),
		import("node:fs/promises"),
		import("node:os"),
		import("node:path"),
		import("node:net"),
		import("node:module"),
	]);
	const port = await new Promise<number>((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
	const dir = await mkdtemp(join(tmpdir(), "qf-workerd-"));
	const entries = [];
	for (const [name, source] of Object.entries(modules)) {
		await writeFile(join(dir, name), source);
		entries.push(`(name = "${name}", ${name.endsWith(".json") ? "json" : "esModule"} = embed "${name}")`);
	}
	await writeFile(
		join(dir, "config.capnp"),
		`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
	services = [(name = "main", worker = (
		modules = [${entries.join(", ")}],
		compatibilityDate = "2026-10-06",
		compatibilityFlags = ["nodejs_compat"],
		${worker}
	))],
	sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`,
	);
	const binary: string = createRequire(import.meta.url)("workerd").default;
	const child = spawn(binary, ["serve", join(dir, "config.capnp"), "--experimental"], { stdio: ["ignore", "ignore", "inherit"] });
	const url = `http://127.0.0.1:${port}`;
	for (let attempt = 0; ; attempt++) {
		const up = await fetch(`${url}/__ping`).then(
			() => true,
			() => false,
		);
		if (up) break;
		if (attempt > 100) throw new Error("workerd did not start");
		await new Promise((r) => setTimeout(r, 100));
	}
	return {
		url,
		async stop() {
			child.kill();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Bundles a source file into one ES module, as the Worker build would. */
export async function bundle(entry: string): Promise<string> {
	const { build } = await import("rolldown");
	const result = await build({ input: new URL(entry, import.meta.url).pathname, platform: "neutral", write: false, output: { format: "esm" }, logLevel: "silent" });
	return result.output[0].code;
}
