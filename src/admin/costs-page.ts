import { dayCost, monthOverage, type AccountUsage } from "../account-usage.ts";
import { CONTAINER_PRICES } from "../checks/tests/container.ts";
import { DEFAULT_INSTANCE } from "../checks/tests/instances.ts";
import { boxResources, CONTAINER_INCLUDED, containerCost, containerOverage, type ContainerResources } from "../container-costs.ts";
import { cost, INCLUDED, LOST_AFTER_MS, monthCost, PRICES, type AttemptRow, type ContainerRow, type ContainerUsage, type ShardOutcome, type Usage, type UsageRow } from "../metrics.ts";
import { esc, layout, renderHeader, select } from "./page.ts";

/** Usage and estimated cost: the run pages' "Usage and cost" section and the /admin/costs page. */

export function money(usd: number): string {
	return usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function cpu(ms: number): string {
	return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
}

const n = (value: number) => value.toLocaleString("en-US");

/** A container's estimated gross cost: memory and disk for the time it was on, CPU as used. */
export const boxesCost = (c: ContainerUsage) => containerCost(boxResources(c));

/** Cells for a run in the runs list: Dynamic Workers and estimated cost, Dynamic Workers and container together. */
export function usageCells(u: Usage | undefined, box?: ContainerUsage): string {
	if (!u && !box) return '<td class="num">—</td><td class="num">—</td>';
	const trouble = u?.crashes ? ` <span class="failure" title="Dynamic Workers that crashed">${u.crashes}✗</span>` : "";
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

/** A label, its value and, optionally, what the label means. */
type Stat = [string, string, string?];

function statList(items: Stat[]): string {
	return `<dl class="stats">${items.map(([k, v, title]) => `<div><dt${title ? ` title="${esc(title)}"` : ""}>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
}

/** What the counts with less obvious names mean, for their labels' titles. */
const MEANING = {
	attempts: "Each group of test files the queue delivered to a Dynamic Worker; a retried batch counts again.",
	retries: "Batches the queue delivered again after an error.",
	crashes: "Usually out of memory; the batch is split and runs again.",
	splits: "Batches broken into smaller ones after a crash.",
};

/** The numbers that drive the cost first; the ones that explain them after. */
const mainStats = (u: Usage): Stat[] => [
	["Estimated cost", money(cost(u))],
	["Dynamic Workers", n(u.dynamicWorkers)],
	["Dynamic Workers CPU", cpu(u.cpuMs)],
];
const detailStats = (u: Usage): Stat[] => [
	["Batches run", n(u.attempts), MEANING.attempts],
	["Total batch time", cpu(u.wallMs)],
	["Retried batches", n(u.retries), MEANING.retries],
	["Crashed Dynamic Workers", n(u.crashes), MEANING.crashes],
	["Split batches", n(u.splits), MEANING.splits],
];

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
		${statList([...mainStats(u), ...detailStats(u)])}
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

/** A unit price, as small as it is: "$0.0000025". */
const price = (usd: number) => `$${usd.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;

const BILLING = '<a href="https://dash.cloudflare.com/?to=/:account/billing">Billing &gt; Billable Usage</a>';

/** Something that counts against a monthly allowance. */
interface Allowance {
	label: string;
	used: number;
	included: number;
	format: (value: number) => string;
}

/** Container usage against the monthly allowance, as Cloudflare bills it. */
function containerAllowances(r: ContainerResources): Allowance[] {
	return [
		{ label: "Container memory", used: r.memoryGiBs, included: CONTAINER_INCLUDED.memoryGiBs, format: (v) => `${hours(v)} GiB-h` },
		{ label: "Container CPU", used: r.vcpuS, included: CONTAINER_INCLUDED.vcpuS, format: (v) => `${n(Math.round(v / 60))} vCPU-min` },
		{ label: "Container disk", used: r.diskGBs, included: CONTAINER_INCLUDED.diskGBs, format: (v) => `${hours(v)} GB-h` },
	];
}

function accountAllowances(month: AccountUsage["month"]): Allowance[] {
	return [
		{ label: "Dynamic Workers", used: month.dynamicWorkers, included: INCLUDED.dynamicWorkers, format: n },
		{ label: "Account CPU", used: month.accountCpuMs, included: INCLUDED.cpuMs, format: cpu },
		...containerAllowances(month.containers),
	];
}

const share = (a: Allowance) => a.used / a.included;

function percent(a: Allowance): string {
	const value = share(a) * 100;
	return value > 0 && value < 1 ? "<1%" : `${n(Math.round(value))}%`;
}

/** Each allowance as "used of included", its share and a bar; the text carries everything the bar shows. */
function renderAllowances(items: Allowance[]): string {
	return `<dl class="stats meters">${items
		.map((a) => {
			return `<div><dt>${esc(a.label)}</dt><dd>${esc(a.format(a.used))} of ${esc(a.format(a.included))} <span class="pct${share(a) > 1 ? " failure" : ""}">${esc(percent(a))}</span><meter min="0" max="${a.included}" value="${a.used}" high="${a.included * 0.8}" optimum="0" aria-hidden="true"></meter></dd></div>`;
		})
		.join("")}</dl>`;
}

/** A collapsed note on where the numbers come from, kept out of the way of the numbers. */
const how = (summary: string, text: string) => `<details class="plain"><summary>${summary}</summary><p class="hint">${text}</p></details>`;

/**
 * The page's answer: is the month still inside the allowance? From what Cloudflare measured when
 * it could be read, otherwise from the estimates (which only see the tests, maybe of one repository).
 */
function renderLead(account: AccountUsage | string | undefined, tests: UsageRow | undefined, boxes: ContainerRow | undefined, repo: string | undefined): string {
	const verdict = (period: string, over: number) => `the allowance in ${esc(period)}: ${money(over)} to pay so far`;
	const box = (over: number, text: string, note: string) => `<div class="lead${over ? " over" : ""}"><p class="verdict">${text}</p><p class="hint">${note}</p></div>`;
	if (account && typeof account !== "string") {
		const over = monthOverage(account.month);
		const closest = accountAllowances(account.month).reduce((a, b) => (share(b) > share(a) ? b : a));
		return box(
			over,
			`${over ? "Past" : "Within"} ${verdict(account.month.period, over)}`,
			`Measured by Cloudflare on the whole account. Highest use: ${esc(closest.label)}, ${esc(percent(closest))} of the allowance. Calendar month in UTC; the real charge is in ${BILLING}.`,
		);
	}
	const why = typeof account === "string" ? "The account's measured usage could not be read" : "The account's measured usage is not available";
	const period = tests?.period ?? boxes?.period;
	if (!period) return box(0, "No usage recorded this month", `${why}, and the tests recorded no usage.`);
	const over = (tests ? monthCost(tests) : 0) + (boxes ? containerOverage(boxResources(boxes)) : 0);
	return box(
		over,
		`Estimate: ${over ? "past" : "within"} ${verdict(period, over)}`,
		`${why} (<a href="#account">details</a>). The estimate only sees the tests${repo ? ` of ${esc(repo)}` : ""}; other Workers on the account share the same allowance.`,
	);
}

/** What Cloudflare measured on the whole account: the numbers it bills, without per-run detail. */
function renderAccount(account: AccountUsage | string | undefined): string {
	if (account === undefined) return "";
	if (typeof account === "string")
		return `<section id="account"><h3>Measured account usage</h3><p class="hint failure">Could not read the account's real usage: ${esc(account)}</p></section>`;
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
	const more: Stat[] = [
		["quality-flare CPU", cpu(month.cpuMs), "This Worker's CPU (webhook, queue and cron), already part of the account CPU."],
		["Invocations with errors", n(month.errors)],
		["Containers past the allowance", money(containerOverage(month.containers))],
	];
	return `<section id="account">
		<h3>Measured account usage, month ${esc(month.period)}</h3>
		${renderAllowances(accountAllowances(month))}
		<details class="plain"><summary>More numbers for the month</summary>${statList(more)}</details>
		${
			days.length
				? `<details class="plain"><summary>By day (last 30 days)</summary><div class="scroll"><table><thead><tr><th>Day</th><th class="num">Dynamic Workers</th><th class="num">quality-flare CPU</th><th class="num">Invocations</th><th class="num">Errors</th><th class="num">Account CPU</th><th class="num">Containers</th><th class="num">Gross cost</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
				: ""
		}
		${how(
			"How we measure",
			`Real numbers from Cloudflare Analytics for the whole account, not split by run. The charge is what goes past the calendar month's allowance (UTC); your billing cycle may differ. Containers add up memory and disk for the time they were on, plus the CPU used. Requests and queue operations stay within the allowance and are not shown. The real charge is in ${BILLING}.`,
		)}
	</section>`;
}

/** Estimates for the Tests check, from what each shard attempt recorded. */
function renderTests(days: UsageRow[], months: UsageRow[]): string {
	const head = `<tr><th>Period</th><th class="num">Runs</th><th class="num" title="${MEANING.attempts}">Batches</th><th class="num" title="${MEANING.retries}">Retries</th><th class="num" title="${MEANING.crashes}">Crashes</th><th class="num">Dynamic Workers</th><th class="num">DW CPU</th><th class="num">Cost</th>`;
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
	return `<section id="tests">
		<h4>Tests on Dynamic Workers${current ? `, month ${esc(current.period)}` : ""}</h4>
		${
			current
				? `${statList([...mainStats(current), ["Past allowance", money(monthCost(current))]])}
					<details class="plain"><summary>More numbers for the month</summary>${statList([["Runs", n(current.runs)], ...detailStats(current)])}</details>`
				: '<p class="empty">No batches recorded.</p>'
		}
		<details class="plain"><summary>By day (last 30 days, UTC)</summary>${table(days, false)}</details>
		<details class="plain"><summary>By month</summary>${table(months, true)}</details>
		${how(
			"How we estimate",
			`Each batch of the Tests check (a group of test files the queue delivers to a Dynamic Worker) records the Dynamic Workers it created and the CPU they used. The cost adds up Dynamic Workers (${price(PRICES.dynamicWorker)} each), CPU (${price(PRICES.cpuMs * 1_000_000)} per million ms), requests and queue operations, at list price. “Past allowance” takes off the monthly allowance (${n(INCLUDED.dynamicWorkers)} Dynamic Workers and ${n(INCLUDED.cpuMs / 1_000_000)} million CPU ms) as if only these tests used it; on the account it is shared with the other Workers. It does not include the CPU of the queue consumer, which builds the batches' code. When a Dynamic Worker crashes, usually out of memory, the batch is split into smaller ones and runs again.`,
		)}
	</section>`;
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
	const stats: Stat[] = current
		? [
				["Estimated cost", money(boxesCost(current))],
				["Past allowance", money(containerOverage(boxResources(current)))],
				["Runs", n(current.runs)],
				["Time on", cpu(current.wallMs)],
			]
		: [];
	return `<section id="containers">
		<h4>Container tests${current ? `, month ${esc(current.period)}` : ""}</h4>
		${current ? `${statList(stats)}${renderAllowances(containerAllowances(boxResources(current)))}` : '<p class="empty">No containers recorded.</p>'}
		<details class="plain"><summary>By day (last 30 days, UTC)</summary>${table(days, false)}</details>
		<details class="plain"><summary>By month</summary>${table(months, true)}</details>
		${how(
			"How we estimate",
			`Each run starts a container of the instance type that <code>container.instance</code> in quality-flare.json picks (${esc(DEFAULT_INSTANCE)} by default). Memory (${price(CONTAINER_PRICES.memoryGiBs)} per GiB-s) and disk (${price(CONTAINER_PRICES.diskGBs)} per GB-s) count for the time it is on; CPU (${price(CONTAINER_PRICES.vcpuS)} per vCPU-s) counts for what it used. Each month the account includes ${hours(CONTAINER_INCLUDED.memoryGiBs)} GiB-h of memory, ${n(CONTAINER_INCLUDED.vcpuS / 60)} vCPU-min and ${hours(CONTAINER_INCLUDED.diskGBs)} GB-h of disk, counted here as if only these tests used it.`,
		)}
	</section>`;
}

export function renderCostsPage({ days, months, repos, repo, account, containerDays = [], containerMonths = [], email }: CostsPageData): string {
	const filters = `<form class="filters" method="get" action="/admin/costs#estimates">
		${select("repo", "Repository", repo ?? "", [["", "All repositories"], ...repos.map((r): [string, string] => [r, r])])}
		<button type="submit" class="secondary">Apply</button>
		${repo ? '<a href="/admin/costs#estimates">Clear</a>' : ""}
	</form>`;
	const index = [
		...(account === undefined ? [] : [["account", "Measured account usage"]]),
		["tests", "Estimate: Tests"],
		["containers", "Estimate: Container tests"],
	];
	return layout(
		"Costs",
		`${renderHeader(email, "costs")}
		<main class="costs">
			<h2>Costs</h2>
			${renderLead(account, months[0], containerMonths[0], repo)}
			<nav class="toc" aria-label="On this page">${index.map(([id, text]) => `<a href="#${id}">${text}</a>`).join("")}</nav>
			${renderAccount(account)}
			<section id="estimates">
				<h3>Estimates by repository</h3>
				<p class="hint">Worked out from what each test run records. The filter only applies to the estimates; the measured usage above is for the whole account.</p>
				${filters}
				${renderTests(days, months)}
				${renderContainers(containerDays, containerMonths)}
			</section>
		</main>`,
	);
}
