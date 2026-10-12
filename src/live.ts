import type { ProgressEvent } from "./checks/tests/report.ts";
import type { CheckResult } from "./checks/types.ts";

/** What the admin receives over its WebSocket while test runs happen. */
export type LiveEvent =
	| { type: "started"; runId: number; repo: string; pr: number; sha: string }
	| ({ runId: number } & ProgressEvent)
	| { type: "finished"; runId: number; conclusion: CheckResult["conclusion"]; title: string };

/** Progress kept for a running run, so a page opened mid-run starts from where it is. */
interface RunProgress {
	runId: number;
	startedAt: number;
	total?: number;
	tests: Extract<LiveEvent, { type: "test" }>[];
}

const HUB = "runs";
/** Progress of a run that never finished (the Worker ran out of time) is dropped after this. */
const FORGET_AFTER_MS = 10 * 60_000;

/**
 * One Durable Object relays every test run's progress to the admin pages watching it.
 * The Tests check POSTs batches of events; pages hold hibernatable WebSockets tagged with
 * the run they watch ("all" for the list). On connect, a page gets the progress so far.
 */
export class RunsHub {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
		private readonly now = () => Date.now(),
	) {}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			const run = new URL(request.url).searchParams.get("run") ?? "all";
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1], [run]);
			for (const progress of await this.progress(run)) pair[1].send(JSON.stringify({ type: "snapshot", ...progress }));
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		if (request.method === "POST") {
			await this.publish((await request.json()) as LiveEvent[]);
			return new Response(null, { status: 204 });
		}
		return new Response("Not found", { status: 404 });
	}

	private async publish(events: LiveEvent[]) {
		const touched = new Map<number, RunProgress | null>();
		const load = async (runId: number) => {
			if (!touched.has(runId)) touched.set(runId, (await this.ctx.storage.get<RunProgress>(key(runId))) ?? null);
			return touched.get(runId) ?? null;
		};
		for (const event of events) {
			if (event.type === "started") touched.set(event.runId, { runId: event.runId, startedAt: this.now(), tests: [] });
			else if (event.type === "finished") touched.set(event.runId, null);
			else {
				const progress = await load(event.runId);
				if (progress && event.type === "collected") progress.total = event.total;
				if (progress && event.type === "test") progress.tests.push(event);
			}
			const message = JSON.stringify(event);
			for (const tag of ["all", String(event.runId)]) {
				for (const ws of this.ctx.getWebSockets(tag)) {
					try {
						ws.send(message);
					} catch {
						// The page went away; the runtime closes the socket.
					}
				}
			}
		}
		for (const [runId, progress] of touched) {
			if (progress) await this.ctx.storage.put(key(runId), progress);
			else await this.ctx.storage.delete(key(runId));
		}
	}

	/** Progress of the runs a page watches: one run, or every run still going. */
	private async progress(run: string): Promise<RunProgress[]> {
		const all = run === "all" ? [...(await this.ctx.storage.list<RunProgress>({ prefix: "run:" })).values()] : [];
		const one = run === "all" ? [] : [await this.ctx.storage.get<RunProgress>(key(Number(run)))].filter((p) => p !== undefined);
		const live: RunProgress[] = [];
		for (const progress of [...all, ...one]) {
			if (this.now() - progress.startedAt > FORGET_AFTER_MS) await this.ctx.storage.delete(key(progress.runId));
			else live.push(progress);
		}
		return live;
	}

	webSocketMessage() {}

	webSocketClose(ws: WebSocket, code: number) {
		ws.close(code === 1005 ? 1000 : code, "closing");
	}
}

const key = (runId: number) => `run:${runId}`;

/** The single RunsHub instance. */
export const hub = (namespace: DurableObjectNamespace) => namespace.get(namespace.idFromName(HUB));

/**
 * Sends events to the hub without slowing the tests down: one request in flight at a time,
 * carrying everything queued meanwhile. Failures are dropped; the admin is a best-effort view.
 */
export function livePublisher(namespace: DurableObjectNamespace | undefined) {
	let queue: LiveEvent[] = [];
	let sending: Promise<void> | undefined;
	const drain = async () => {
		while (queue.length) {
			const batch = queue;
			queue = [];
			await hub(namespace!)
				.fetch("https://hub/publish", { method: "POST", body: JSON.stringify(batch) })
				.catch(() => {});
		}
		sending = undefined;
	};
	return {
		send(event: LiveEvent) {
			if (!namespace) return;
			queue.push(event);
			sending ??= drain();
		},
		/** Resolves once everything sent so far reached the hub (or failed). */
		async flush() {
			while (sending) await sending;
		},
	};
}
