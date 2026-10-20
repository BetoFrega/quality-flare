import { dayCost, monthOverage, type AccountUsage } from "../account-usage.ts";
import { DEFAULT_INSTANCE } from "../checks/tests/instances.ts";
import { boxResources, CONTAINER_INCLUDED, containerCost, containerOverage, type ContainerResources } from "../container-costs.ts";
import { cost, INCLUDED, LOST_AFTER_MS, monthCost, PRICES, type AttemptRow, type ContainerRow, type ContainerUsage, type ShardOutcome, type Usage, type UsageRow } from "../metrics.ts";
import { esc, layout, renderHeader, select } from "./page.ts";

/** Usage and estimated cost: the run pages' "Usage and cost" section and the /admin/costs page. */

export function money(usd: number): string {
	return usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function cpu(ms: number): string {
	return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 1_000_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1_000_000).toFixed(1)}M ms`;
}

const n = (value: number) => value.toLocaleString("en-US");

/** A container's estimated gross cost: memory and disk for the time it was on, CPU as used. */
export const boxesCost = (c: ContainerUsage) => containerCost(boxResources(c));

/** Cells for a run in the runs list: Dynamic Workers and estimated cost, Dynamic Workers and container together. */
export function usageCells(u: Usage | undefined, box?: ContainerUsage): string {
	if (!u && !box) return '<td class="num">—</td><td class="num">—</td>';
	const trouble = u?.crashes ? ` <span class="failure" title="crashes">${u.crashes}✗</span>` : "";
	const dw = u ? `${n(u.dynamicWorkers)}${trouble}` : '<span title="Ran in a container">—</span>';
	return `<td class="num">${dw}</td><td class="num">${money((u ? cost(u) : 0) + (box ? boxesCost(box) : 0))}</td>`;
}

const OUTCOME: Record<ShardOutcome, string> = {
	ran: "Ran",
	rechecked: "Ran; failures rerun alone",
	split: "Split (after a crash)",
	crashed: "Dynamic Worker crashed; split",
	"too-large": "Code too large; split",
	expired: "Past the deadline",
	"gave-up": "Gave up after crashes",
	failed: "Did not run (error)",
	skipped: "Skipped (run ended)",
	error: "Error; will retry",
};

function stats(u: Usage, extra: [string, string][] = []): string {
	const items: [string, string][] = [
		["Estimated cost", money(cost(u))],
		["Dynamic Workers", n(u.dynamicWorkers)],
		["Dynamic Workers CPU", cpu(u.cpuMs)],
		["Batches (queue deliveries)", n(u.attempts)],
		["Total batch time", cpu(u.wallMs)],
		["Retries", n(u.retries)],
		["Crashes (memory)", n(u.crashes)],
		["Splits", n(u.splits)],
		...extra,
	];
	return `<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
}

/** The run page's usage section: totals and every shard attempt. In a run that is over, an attempt that never ended crashed. */
export function renderRunUsage(u: Usage | undefined, attempts: AttemptRow[], now: number, over: boolean): string {
	if (!u || !attempts.length) return "";
	const rows = attempts
		.map((a) => {
			const lost = !a.outcome && (over || (a.startedAt ?? now) < now - LOST_AFTER_MS);
			const outcome = a.outcome ? OUTCOME[a.outcome] : lost ? "Crashed (consumer out of memory?)" : "Running";
			const dw = a.dwOutcome && a.dwOutcome !== "ok" ? ` <span class="failure">${esc(a.dwOutcome)}</span>` : "";
			return `<tr>
				<td class="mono">${esc(a.shard)}${a.attempt > 1 ? ` #${a.attempt}` : ""}</td>
				<td class="num">${a.files ?? "—"}</td>
				<td class="${lost || a.outcome === "crashed" ? "failure" : ""}">${esc(outcome)}${dw}</td>
				<td class="num">${a.codeBytes ? `${(a.codeBytes / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
				<td class="num">${a.startedAt && a.finishedAt ? cpu(a.finishedAt - a.startedAt) : "—"}</td>
				<td class="num">${a.cpuMs !== null ? cpu(a.cpuMs) : "—"}</td>
			</tr>`;
		})
		.join("");
	return `<section class="usage">
		<h3>Usage and cost</h3>
		${stats(u)}
		<p class="hint">Estimate without the monthly allowance. It does not include the CPU of the queue consumer, which builds the batches' code.</p>
		<details class="plain"><summary>${n(attempts.length)} batch deliveries</summary>
			<div class="scroll"><table><thead><tr><th>Batch</th><th class="num">Files</th><th>Result</th><th class="num">Code</th><th class="num">Time</th><th class="num">DW CPU</th></tr></thead><tbody>${rows}</tbody></table></div>
		</details>
	</section>`;
}

export interface CostsPageData {
	days: UsageRow[];
	months: UsageRow[];
	repos: string[];
	repo?: string;
	/** The account's real usage, or why it couldn't be read. */
	account?: AccountUsage | string;
	/** Container tests runs, per day and per month. */
	containerDays?: ContainerRow[];
	containerMonths?: ContainerRow[];
	email?: string;
}

const hours = (seconds: number) => (seconds / 3600).toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Container usage against the monthly allowance, as Cloudflare bills it. */
function containerItems(r: ContainerResources): [string, string][] {
	return [
		["Container memory", `${hours(r.memoryGiBs)} of ${hours(CONTAINER_INCLUDED.memoryGiBs)} GiB-h`],
		["Container CPU", `${n(Math.round(r.vcpuS / 60))} of ${n(CONTAINER_INCLUDED.vcpuS / 60)} vCPU-min`],
		["Container disk", `${hours(r.diskGBs)} of ${hours(CONTAINER_INCLUDED.diskGBs)} GB-h`],
	];
}

/** What Cloudflare measured on the whole account: the numbers it bills, without per-run detail. */
function renderAccount(account: AccountUsage | string | undefined): string {
	if (account === undefined) return "";
	if (typeof account === "string") return `<h3>Cloudflare account</h3><p class="hint failure">Could not read the account's real usage: ${esc(account)}</p>`;
	const { month, days } = account;
	const rows = days
		.map(
			(d) => `<tr>
			<td class="mono">${esc(d.date)}</td>
			<td class="num">${n(d.dynamicWorkers)}</td>
			<td class="num">${cpu(d.cpuMs)}</td>
			<td class="num">${n(d.requests)}</td>
			<td class="num${d.errors ? " failure" : ""}">${n(d.errors)}</td>
			<td class="num">${cpu(d.accountCpuMs)}</td>
			<td class="num">${money(containerCost(d.containers))}</td>
			<td class="num">${money(dayCost(d))}</td>
		</tr>`,
		)
		.join("");
	const items: [string, string][] = [
		["Estimated charge this month", money(monthOverage(month))],
		["Dynamic Workers", `${n(month.dynamicWorkers)} of ${n(INCLUDED.dynamicWorkers)}`],
		["Account CPU", `${cpu(month.accountCpuMs)} of ${cpu(INCLUDED.cpuMs)}`],
		["quality-flare CPU", cpu(month.cpuMs)],
		["Invocations with errors", n(month.errors)],
		...containerItems(month.containers),
		["Containers past the allowance", money(containerOverage(month.containers))],
	];
	return `<h3>Cloudflare account, month ${esc(month.period)} (measured)</h3>
		<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
		<p class="hint">Real numbers from Cloudflare Analytics for the whole account, not split by run. Containers add up memory and disk for the time they were on, plus the CPU used. The estimated charge is what goes past the month's allowance (calendar month, UTC; your billing cycle may differ). Requests and queue operations stay within the allowance.</p>
		${
			days.length
				? `<details class="plain"><summary>By day (last 30 days)</summary><div class="scroll"><table><thead><tr><th>Day</th><th class="num">Dynamic Workers</th><th class="num">quality-flare CPU</th><th class="num">Invocations</th><th class="num">Errors</th><th class="num">Account CPU</th><th class="num">Containers</th><th class="num">Gross cost</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
				: ""
		}`;
}

/** Estimates for the Container tests check, from what each run's container recorded. */
function renderContainers(days: ContainerRow[], months: ContainerRow[]): string {
	const row = (r: ContainerRow, month: boolean) => `<tr>
		<td class="mono">${esc(r.period)}</td>
		<td class="num">${n(r.runs)}</td>
		<td class="num">${cpu(r.wallMs)}</td>
		<td class="num${r.unmeasured ? " failure" : ""}" ${r.unmeasured ? `title="${r.unmeasured} without measured CPU"` : ""}>${cpu(Math.round(r.cpuUs / 1000))}</td>
		<td class="num">${money(boxesCost(r))}</td>
		${month ? `<td class="num">${money(containerOverage(boxResources(r)))}</td>` : ""}
	</tr>`;
	const table = (rows: ContainerRow[], month: boolean) =>
		rows.length
			? `<div class="scroll"><table><thead><tr><th>Period</th><th class="num">Runs</th><th class="num">Time on</th><th class="num">CPU used</th><th class="num">Cost</th>${month ? '<th class="num">Past allowance</th>' : ""}</tr></thead><tbody>${rows.map((r) => row(r, month)).join("")}</tbody></table></div>`
			: '<p class="empty">No containers recorded in this period.</p>';
	const current = months[0];
	const summary = current
		? `<h3>Containers, month ${esc(current.period)}</h3><dl class="stats">${(
				[
					["Estimated cost", money(boxesCost(current))],
					["Past allowance", money(containerOverage(boxResources(current)))],
					["Runs", n(current.runs)],
					["Time on", cpu(current.wallMs)],
					...containerItems(boxResources(current)),
				] as [string, string][]
			)
				.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
				.join("")}</dl>`
		: "";
	return `<h3>Container tests estimate</h3>
		<p class="hint">Each run starts a container of the instance type that <code>container.instance</code> in quality-flare.json picks (${esc(DEFAULT_INSTANCE)} by default). Memory ($0.0000025 per GiB-s) and disk ($0.00000007 per GB-s) count for the time it is on; CPU ($0.00002 per vCPU-s) counts for what it used. Each month the account includes ${hours(CONTAINER_INCLUDED.memoryGiBs)} GiB-h of memory, ${n(CONTAINER_INCLUDED.vcpuS / 60)} vCPU-min and ${hours(CONTAINER_INCLUDED.diskGBs)} GB-h of disk.</p>
		${summary}
		<h3>Containers by day (last 30 days, UTC)</h3>
		${table(days, false)}
		<h3>Containers by month</h3>
		${table(months, true)}`;
}

export function renderCostsPage({ days, months, repos, repo, account, containerDays = [], containerMonths = [], email }: CostsPageData): string {
	const head = '<tr><th>Period</th><th class="num">Runs</th><th class="num">Batches</th><th class="num">Retries</th><th class="num">Crashes</th><th class="num">Dynamic Workers</th><th class="num">DW CPU</th><th class="num">Cost</th>';
	const row = (r: UsageRow, month: boolean) => `<tr>
		<td class="mono">${esc(r.period)}</td>
		<td class="num">${n(r.runs)}</td>
		<td class="num">${n(r.attempts)}</td>
		<td class="num">${n(r.retries)}</td>
		<td class="num${r.crashes ? " failure" : ""}">${n(r.crashes)}</td>
		<td class="num">${n(r.dynamicWorkers)}</td>
		<td class="num">${cpu(r.cpuMs)}</td>
		<td class="num">${money(cost(r))}</td>
		${month ? `<td class="num">${money(monthCost(r))}</td>` : ""}
	</tr>`;
	const table = (rows: UsageRow[], month: boolean) =>
		rows.length
			? `<div class="scroll"><table><thead>${head}${month ? '<th class="num">Past allowance</th>' : ""}</tr></thead><tbody>${rows.map((r) => row(r, month)).join("")}</tbody></table></div>`
			: '<p class="empty">No batches recorded in this period.</p>';
	const current = months[0];
	const filters = `<form class="filters" method="get" action="/admin/costs">
		${select("repo", "Repository", repo ?? "", [["", "All repositories"], ...repos.map((r): [string, string] => [r, r])])}
		<button type="submit" class="secondary">Apply</button>
		${repo ? '<a href="/admin/costs">Clear</a>' : ""}
	</form>`;
	return layout(
		"Costs",
		`${renderHeader(email, "costs")}
		<main>
			<h2>Costs</h2>
			${renderAccount(account)}
			<h3>Dynamic Workers tests estimate</h3>
			<p class="hint">Estimated from what each batch of the Tests check records: Dynamic Workers created ($${PRICES.dynamicWorker} each), Dynamic Workers CPU ($0.02 per million ms), requests and queue operations. The queue consumer's CPU is not included. Each month the account includes ${n(INCLUDED.dynamicWorkers)} Dynamic Workers and ${n(INCLUDED.cpuMs / 1_000_000)} million ms of CPU, shared with your other Workers. The amount actually billed is in <a href="https://dash.cloudflare.com/?to=/:account/billing">Billing &gt; Billable Usage</a>.</p>
			${filters}
			${current ? `<h3>Tests, month ${esc(current.period)}</h3>${stats(current, [["Past allowance", money(monthCost(current))]])}` : ""}
			<h3>Tests by day (last 30 days, UTC)</h3>
			${table(days, false)}
			<h3>Tests by month</h3>
			${table(months, true)}
			${renderContainers(containerDays, containerMonths)}
		</main>`,
	);
}
