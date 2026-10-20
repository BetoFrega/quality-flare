import { describe, expect, it } from "vitest";
import { livePublisher, type LiveEvent } from "../src/live.ts";
import { bundle, serveWorkerd } from "./workerd.ts";

const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";

/** Opens a WebSocket to the hub and collects what it receives. */
async function watch(url: string, run: string) {
	const messages: Record<string, unknown>[] = [];
	const ws = new WebSocket(`${url.replace("http", "ws")}/live?run=${run}`);
	ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)));
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	return { messages, close: () => ws.close() };
}

const until = async (check: () => boolean) => {
	for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
};

// Runs the real RunsHub Durable Object on workerd, so it only runs under Node.
describe.skipIf(inWorkers)("RunsHub", () => {
	it("relays events to the pages watching a run, and catches up late ones", async () => {
		const hub = await bundle("../src/live.ts");
		const host = `export { RunsHub } from "hub.js";
import { hub } from "hub.js";
export default { fetch(request, env) {
	const { pathname } = new URL(request.url);
	return pathname === "/live" || pathname === "/publish" ? hub(env.LIVE).fetch(request) : new Response("up");
} };`;
		const server = await serveWorkerd(
			{ "host.js": host, "hub.js": hub },
			`bindings = [(name = "LIVE", durableObjectNamespace = "RunsHub")],
		durableObjectNamespaces = [(className = "RunsHub", uniqueKey = "runs-hub", enableSql = true)],
		durableObjectStorage = (inMemory = void),`,
		);
		const publish = (events: object[]) => fetch(`${server.url}/publish`, { method: "POST", body: JSON.stringify(events) });
		try {
			const list = await watch(server.url, "all");
			const other = await watch(server.url, "2");
			await publish([
				{ type: "started", runId: 1, repo: "octo/app", pr: 4, sha: "abc" },
				{ type: "status", runId: 1, text: "Lote 0: rodando" },
				{ type: "collected", runId: 1, total: 2 },
				{ type: "test", runId: 1, file: "test/a.test.ts", name: "adds", state: "pass" },
				{ type: "counts", runId: 1, pass: 1, fail: 0, other: 0, total: 2 },
			]);
			await until(() => list.messages.length === 5);
			expect(list.messages.map((m) => m.type)).toEqual(["started", "status", "collected", "test", "counts"]);

			// A page opened mid-run starts from the progress so far.
			const late = await watch(server.url, "1");
			await until(() => late.messages.length === 1);
			expect(late.messages[0]).toMatchObject({ type: "snapshot", runId: 1, total: 2, status: "Lote 0: rodando", tests: [{ name: "adds", state: "pass" }], counts: { pass: 1, total: 2 } });

			await publish([{ type: "finished", runId: 1, conclusion: "success", title: "2 tests passed" }]);
			await until(() => late.messages.length === 2);
			expect(late.messages[1]).toMatchObject({ type: "finished", runId: 1 });
			expect(other.messages).toEqual([]);

			// Finished runs are forgotten.
			const after = await watch(server.url, "all");
			await new Promise((r) => setTimeout(r, 200));
			expect(after.messages).toEqual([]);
			for (const ws of [list, other, late, after]) ws.close();
		} finally {
			await server.stop();
		}
	}, 30_000);
});

describe("livePublisher", () => {
	it("batches events while a request is in flight and keeps their order", async () => {
		const batches: LiveEvent[][] = [];
		const stub = {
			fetch: async (_url: string, init: RequestInit) => {
				batches.push(JSON.parse(init.body as string));
				await new Promise((r) => setTimeout(r, 10));
				return new Response(null, { status: 204 });
			},
		};
		const namespace = { idFromName: () => "id", get: () => stub } as unknown as DurableObjectNamespace;
		const live = livePublisher(namespace);
		live.send({ type: "started", runId: 1, repo: "o/r", pr: 1, sha: "a" });
		for (let i = 0; i < 5; i++) live.send({ type: "test", runId: 1, file: "a.test.ts", name: `t${i}`, state: "pass" });
		await live.flush();
		expect(batches.map((b) => b.length)).toEqual([1, 5]);
		expect(batches.flat().map((e) => e.type)).toEqual(["started", "test", "test", "test", "test", "test"]);
	});

	it("does nothing without a hub, and never throws when the hub is down", async () => {
		livePublisher(undefined).send({ type: "finished", runId: 1, conclusion: "success", title: "" });
		const down = { idFromName: () => "id", get: () => ({ fetch: () => Promise.reject(new Error("down")) }) } as unknown as DurableObjectNamespace;
		const live = livePublisher(down);
		live.send({ type: "finished", runId: 1, conclusion: "success", title: "" });
		await expect(live.flush()).resolves.toBeUndefined();
	});
});
