import { INCLUDED, PRICES } from "./metrics.ts";

/**
 * Real usage of the Cloudflare account, from the GraphQL Analytics API: what the account is billed
 * on, as opposed to the per-run estimate the Tests shards record (src/metrics.ts). Needs an API
 * token with Account Analytics: Read, kept in the Secrets Store.
 */

export interface AccountDay {
	/** "2026-10-13", UTC. */
	date: string;
	/** Unique Dynamic Workers that ran that day; each is billed once a day. */
	dynamicWorkers: number;
	/** CPU and requests of this Worker (the webhook, the queue consumer and the cron), and its failed invocations. */
	cpuMs: number;
	requests: number;
	errors: number;
	/** CPU of every Worker on the account, Dynamic Workers included: the monthly allowance is shared. */
	accountCpuMs: number;
}

export interface AccountUsage {
	/** Newest first. */
	days: AccountDay[];
	/** Sums over `days` from the first of the month. */
	month: Omit<AccountDay, "date"> & { period: string };
}

const QUERY = `query ($account: string!, $since: Date!, $until: Date!) {
	viewer {
		accounts(filter: { accountTag: $account }) {
			dynamic: workersInvocationsByOwnerAndScriptGroups(limit: 100, filter: { date_geq: $since, date_leq: $until }) {
				dimensions { date }
				uniq { distinctDynamicWorkerCount }
			}
			workers: workersInvocationsAdaptive(limit: 10000, filter: { date_geq: $since, date_leq: $until }) {
				dimensions { date scriptName }
				sum { cpuTimeUs requests errors }
			}
		}
	}
}`;

interface Response {
	data?: {
		viewer: {
			accounts: {
				dynamic: { dimensions: { date: string }; uniq: { distinctDynamicWorkerCount: number } }[];
				workers: { dimensions: { date: string; scriptName: string }; sum: { cpuTimeUs: number; requests: number; errors: number } }[];
			}[];
		};
	};
	errors?: { message: string }[] | null;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last 30 days, and the month so far; `script` is this Worker's name. */
export async function accountUsage(
	{ token, account, script, now = Date.now(), fetcher = fetch }: { token: string; account: string; script: string; now?: number; fetcher?: typeof fetch },
): Promise<AccountUsage> {
	const until = date(now);
	const monthStart = `${until.slice(0, 7)}-01`;
	const since = date(Math.min(now - 29 * 86_400_000, Date.parse(monthStart)));
	const res = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query: QUERY, variables: { account, since, until } }),
	});
	const body = (await res.json()) as Response;
	const data = body.data?.viewer.accounts[0];
	if (!res.ok || body.errors?.length || !data) {
		throw new Error(`GraphQL Analytics: ${res.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
	}
	const days = new Map<string, AccountDay>();
	const day = (d: string) => days.get(d) ?? days.set(d, { date: d, dynamicWorkers: 0, cpuMs: 0, requests: 0, errors: 0, accountCpuMs: 0 }).get(d)!;
	for (const row of data.dynamic) day(row.dimensions.date).dynamicWorkers += row.uniq.distinctDynamicWorkerCount;
	for (const row of data.workers) {
		const d = day(row.dimensions.date);
		const cpuMs = row.sum.cpuTimeUs / 1000;
		d.accountCpuMs += cpuMs;
		if (row.dimensions.scriptName === script) {
			d.cpuMs += cpuMs;
			d.requests += row.sum.requests;
			d.errors += row.sum.errors;
		}
	}
	const sorted = [...days.values()].map(round).sort((a, b) => b.date.localeCompare(a.date));
	const month = { period: monthStart.slice(0, 7), dynamicWorkers: 0, cpuMs: 0, requests: 0, errors: 0, accountCpuMs: 0 };
	for (const d of sorted.filter((d) => d.date >= monthStart)) {
		month.dynamicWorkers += d.dynamicWorkers;
		month.cpuMs += d.cpuMs;
		month.requests += d.requests;
		month.errors += d.errors;
		month.accountCpuMs += d.accountCpuMs;
	}
	return { days: sorted.filter((d) => d.date >= date(now - 29 * 86_400_000)), month };
}

const round = (d: AccountDay): AccountDay => ({ ...d, cpuMs: Math.round(d.cpuMs), accountCpuMs: Math.round(d.accountCpuMs) });

/** A day's Dynamic Workers and this Worker's CPU, at list price. */
export function dayCost(d: Pick<AccountDay, "dynamicWorkers" | "cpuMs">): number {
	return d.dynamicWorkers * PRICES.dynamicWorker + d.cpuMs * PRICES.cpuMs;
}

/**
 * The month's Dynamic Workers and CPU past the allowances. CPU is the whole account's, since
 * the allowance is shared; requests and queue operations are left out (they stay within it).
 */
export function monthOverage(m: Pick<AccountDay, "dynamicWorkers" | "accountCpuMs">): number {
	return Math.max(0, m.dynamicWorkers - INCLUDED.dynamicWorkers) * PRICES.dynamicWorker + Math.max(0, m.accountCpuMs - INCLUDED.cpuMs) * PRICES.cpuMs;
}
