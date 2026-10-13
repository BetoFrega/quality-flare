import { WorkerEntrypoint } from "cloudflare:workers";
import { d1MetricsStore, type ShardAttempt } from "./metrics.ts";

/**
 * Tail Worker of the Dynamic Workers that run Tests shards (see runInDynamicWorker): records the
 * CPU and wall time each one used, which the consumer can't measure itself, and how it ended
 * ("exceededMemory", "exceededCpu"…). `ctx.props` names the shard attempt.
 */
export class ShardTail extends WorkerEntrypoint<Env, ShardAttempt> {
	override async tail(events: TraceItem[]): Promise<void> {
		const metrics = d1MetricsStore(this.env.RUNS);
		for (const event of events) {
			await metrics
				.trace({ ...this.ctx.props, cpuMs: event.cpuTime, wallMs: event.wallTime, outcome: event.outcome })
				.catch((error: unknown) => console.error("quality-flare: could not record shard usage", error));
		}
	}
}
