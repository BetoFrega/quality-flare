import { containerCost, containerOverage, type ContainerResources } from "./container-costs.ts";
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
	/** Every container on the account (the Container tests check's, so far). */
	containers: ContainerResources;
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
			containers: containersUsageAdaptiveGroups(limit: 100, filter: { date_geq: $since, date_leq: $until }) {
				dimensions { date }
				sum { allocatedMemory allocatedDisk cpuTimeSec }
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
				/** Memory and disk in byte-seconds (they match test_container_runs' time on × the instance's size). */
				containers?: { dimensions: { date: string }; sum: { allocatedMemory: number; allocatedDisk: number; cpuTimeSec: number } }[];
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
	const day = (d: string) =>
		days.get(d) ??
		days.set(d, { date: d, dynamicWorkers: 0, cpuMs: 0, requests: 0, errors: 0, accountCpuMs: 0, containers: { memoryGiBs: 0, vcpuS: 0, diskGBs: 0 } }).get(d)!;
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
	for (const row of data.containers ?? []) {
		const c = day(row.dimensions.date).containers;
		c.memoryGiBs += row.sum.allocatedMemory / 2 ** 30;
		c.diskGBs += row.sum.allocatedDisk / 1e9;
		c.vcpuS += row.sum.cpuTimeSec;
	}
	const sorted = [...days.values()].map(round).sort((a, b) => b.date.localeCompare(a.date));
	const month = {
		period: monthStart.slice(0, 7),
		dynamicWorkers: 0,
		cpuMs: 0,
		requests: 0,
		errors: 0,
		accountCpuMs: 0,
		containers: { memoryGiBs: 0, vcpuS: 0, diskGBs: 0 },
	};
	for (const d of sorted.filter((d) => d.date >= monthStart)) {
		month.dynamicWorkers += d.dynamicWorkers;
		month.cpuMs += d.cpuMs;
		month.requests += d.requests;
		month.errors += d.errors;
		month.accountCpuMs += d.accountCpuMs;
		month.containers.memoryGiBs += d.containers.memoryGiBs;
		month.containers.vcpuS += d.containers.vcpuS;
		month.containers.diskGBs += d.containers.diskGBs;
	}
	return { days: sorted.filter((d) => d.date >= date(now - 29 * 86_400_000)), month };
}

const round = (d: AccountDay): AccountDay => ({ ...d, cpuMs: Math.round(d.cpuMs), accountCpuMs: Math.round(d.accountCpuMs) });

/** A day's Dynamic Workers, this Worker's CPU and the containers, at list price. */
export function dayCost(d: Pick<AccountDay, "dynamicWorkers" | "cpuMs" | "containers">): number {
	return d.dynamicWorkers * PRICES.dynamicWorker + d.cpuMs * PRICES.cpuMs + containerCost(d.containers);
}

/**
 * The month's Dynamic Workers and CPU past the allowances. CPU is the whole account's, since
 * the allowance is shared; requests and queue operations are left out (they stay within it).
 */
export function monthOverage(m: Pick<AccountDay, "dynamicWorkers" | "accountCpuMs" | "containers">): number {
	return (
		Math.max(0, m.dynamicWorkers - INCLUDED.dynamicWorkers) * PRICES.dynamicWorker +
		Math.max(0, m.accountCpuMs - INCLUDED.cpuMs) * PRICES.cpuMs +
		containerOverage(m.containers)
	);
}
