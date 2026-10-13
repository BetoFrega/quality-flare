/** Stands in for the `cloudflare:workers` module when tests import the Worker under Node. */
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
	protected readonly ctx: { props: Props };
	protected readonly env: Env;
	constructor(ctx: { props: Props }, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}
