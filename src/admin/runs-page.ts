import { RUN_SORTS, RUN_STATES, runState, type RunQuery, type RunSort, type TestRun, type TestRunDetail } from "../runs.ts";
import type { AttemptRow, ContainerUsage, Usage } from "../metrics.ts";
import { boxCost, type BoxUsage } from "../checks/tests/container.ts";
import { DEFAULT_INSTANCE, instanceSize } from "../checks/tests/instances.ts";
import { cpu, money, renderRunUsage, usageCells } from "./costs-page.ts";
import { esc, layout, renderHeader, select } from "./page.ts";

const ICON = { success: "✓", failure: "✗", neutral: "–", cancelled: "⊘", running: "●", stale: "!" } as const;

const LIVE = '<script src="/admin/live.js" defer></script>';
/** Without JavaScript (or if the socket fails), running pages still reload on their own. */
const FALLBACK = '<noscript><meta http-equiv="refresh" content="5"></noscript>';

const SORT_LABEL: Record<RunSort, string> = {
	recent: "Most recent",
	oldest: "Oldest",
	longest: "Slowest",
	shortest: "Fastest",
};

/** Reads the runs list's filter and sort from the query string, ignoring values it doesn't know. */
export function runQuery(params: URLSearchParams): RunQuery {
	const state = RUN_STATES.find((s) => s === params.get("state"));
	const sort = RUN_SORTS.find((s) => s === params.get("sort"));
	return { repo: params.get("repo") || undefined, state, sort };
}

export interface RunsPageData {
	runs: TestRun[];
	/** Repositories with runs, offered in the filter. */
	repos: string[];
	query: RunQuery;
	/** Each run's shard usage, by run id; runs from before it was recorded are absent. */
	usage?: Map<number, Usage>;
	/** Each Container tests run's container usage, by run id. */
	containers?: Map<number, ContainerUsage>;
	email?: string;
	now: number;
}

export function renderRunsPage({ runs, repos, query, usage = new Map(), containers = new Map(), email, now }: RunsPageData): string {
	const filtered = Boolean(query.repo || query.state);
	const running = runs.some((r) => runState(r, now) === "running");
	const rows = runs
		.map((run) => {
			const s = runState(run, now);
			return `<tr>
				<td class="state ${s}"><a href="/admin/runs/${run.id}">${ICON[s]} ${LABEL[s]}</a></td>
				<td>${target(run)} <span class="mono">${esc(run.sha.slice(0, 7))}</span></td>
				<td>${s === "running" ? `<span data-progress="${run.id}">Preparing…</span>` : esc(run.title ?? "")}</td>
				<td class="num">${when(run.startedAt, now)}</td>
				<td class="num">${duration(run, now)}</td>
				${usageCells(usage.get(run.id), containers.get(run.id))}
			</tr>`;
		})
		.join("");
	const table = runs.length
		? `<div class="scroll"><table><thead><tr><th>Status</th><th>PR</th><th>Result</th><th class="num">Started</th><th class="num">Duration</th><th class="num" title="Dynamic Workers created (and crashes)">DW</th><th class="num">Est. cost</th></tr></thead><tbody>${rows}</tbody></table></div>`
		: filtered
			? `<p class="empty">No runs match these filters. <a href="/admin/runs">Clear filters</a></p>`
			: `<p class="empty">No runs yet. The Tests check runs when it is enabled on a repository and a PR gets commits.</p>`;
	const filters = `<form class="filters" method="get" action="/admin/runs">
				${select("repo", "Repository", query.repo ?? "", [["", "All repositories"], ...repos.map((r): [string, string] => [r, r])])}
				${select("state", "Status", query.state ?? "", [["", "All statuses"], ...RUN_STATES.map((s): [string, string] => [s, LABEL[s]])])}
				${select("sort", "Sort", query.sort ?? "recent", RUN_SORTS.map((s): [string, string] => [s, SORT_LABEL[s]]))}
				<button type="submit" class="secondary">Apply</button>
				${filtered || (query.sort && query.sort !== "recent") ? '<a href="/admin/runs">Clear</a>' : ""}
			</form>`;
	return layout(
		"Test runs",
		`${renderHeader(email, "runs")}
		<main data-live="all">
			<h2>Test runs</h2>
			<p class="hint">Up to 50 runs of the Tests check. The page follows running tests live.</p>
			${filters}
			${table}
		</main>`,
		`${LIVE}${running ? FALLBACK : ""}`,
	);
}

export function renderRunPage(
	run: TestRunDetail,
	email: string | undefined,
	now: number,
	{ usage, attempts = [], container }: { usage?: Usage; attempts?: AttemptRow[]; container?: BoxUsage } = {},
): string {
	const s = runState(run, now);
	const files = run.report?.files ?? [];
	const fileRows = files
		.map((f) => {
			const passed = f.tests.filter((t) => t.state === "pass").length;
			const failed = f.errors?.length || f.tests.some((t) => t.state === "fail");
			return `<tr><td class="state ${failed ? "failure" : "success"}">${failed ? ICON.failure : ICON.success}</td><td class="mono">${esc(f.path)}</td><td class="num">${passed}/${f.tests.length}</td></tr>`;
		})
		.join("");
	const details = files
		.map(
			(f) => `<h3 class="mono">${esc(f.path)}</h3>
			${(f.errors ?? []).map((e) => `<pre>${esc(e)}</pre>`).join("")}
			<ul class="tests">${f.tests
				.map(
					(t) => `<li><span class="state ${testClass(t.state)}">${testIcon(t.state)}</span> ${esc(t.name)}${(t.errors ?? []).map((e) => `<pre>${esc(e)}</pre>`).join("")}</li>`,
				)
				.join("")}</ul>`,
		)
		.join("");
	const body =
		s === "running"
			? `<p data-progress="${run.id}">Preparing the tests…</p><ul class="tests" data-tests="${run.id}"></ul>`
			: s === "stale"
				? "<p>The run stopped before it finished: the Worker stopped (memory or time limit) without recording the result. Nothing is still running. Run it again with <strong>Re-run</strong> on the PR.</p>"
				: files.length
					? `<table><thead><tr><th></th><th>File</th><th class="num">Passed</th></tr></thead><tbody>${fileRows}</tbody></table>${details}`
					: `<pre>${esc(run.summary ?? "")}</pre>`;
	return layout(
		`Run ${run.id}`,
		`${renderHeader(email, "runs")}
		<main${s === "running" ? ` data-live="${run.id}"` : ""}>
			<p class="hint"><a href="/admin/runs">← Test runs</a></p>
			<h2 class="state ${s}">${ICON[s]} ${esc(run.title ?? LABEL[s])}</h2>
			<p class="meta">
				${target(run)}
				<span class="mono">${esc(run.sha)}</span>
				<span>${when(run.startedAt, now)}</span>
				<span>${duration(run, now)}</span>
			</p>
			${renderRunUsage(usage, attempts, now, s !== "running")}
			${container ? renderContainerUsage(container) : ""}
			${body}
		</main>`,
		s === "running" ? `${LIVE}${FALLBACK}` : "",
	);
}

type State = keyof typeof ICON;

const LABEL: Record<State, string> = {
	success: "Passed",
	failure: "Failed",
	neutral: "Neutral",
	cancelled: "Cancelled",
	running: "Running",
	stale: "Interrupted",
};

const testIcon = (s: string) => (s === "pass" ? ICON.success : s === "fail" ? ICON.failure : ICON.neutral);
const testClass = (s: string) => (s === "pass" ? "success" : s === "fail" ? "failure" : "skip");

function duration(run: TestRun, now: number): string {
	// An interrupted run never ended; the time since it started is not how long anything ran.
	if (runState(run, now) === "stale") return "—";
	const ms = (run.finishedAt ?? now) - run.startedAt;
	return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function when(at: number, now: number): string {
	const s = Math.round((now - at) / 1000);
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return new Date(at).toISOString().slice(0, 10);
}

/** The run page's usage section for a run on the "Container" runner. */
function renderContainerUsage(u: BoxUsage): string {
	const size = instanceSize(u.instance);
	const items: [string, string][] = [
		["Estimated cost", money(boxCost(u))],
		["Container", `${u.instance ?? DEFAULT_INSTANCE} (${size.vcpu} vCPU, ${size.memoryGiB} GiB)`],
		["Time on", cpu(u.wallMs)],
		["CPU used", u.cpuUs === undefined ? "—" : cpu(Math.round(u.cpuUs / 1000))],
	];
	return `<section class="usage">
		<h3>Usage and cost</h3>
		<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
		<p class="hint">Estimate without the monthly allowance: memory and disk for the time it was on, CPU for what it used.</p>
	</section>`;
}

/** The PR a run tested, or the commit for a full run, which has none (pr 0). */
function target(run: Pick<TestRun, "repo" | "pr" | "sha">): string {
	if (!run.pr) return `<a href="https://github.com/${esc(run.repo)}/commit/${esc(run.sha)}">${esc(run.repo)} (full run)</a>`;
	return `<a href="https://github.com/${esc(run.repo)}/pull/${run.pr}">${esc(run.repo)}#${run.pr}</a>`;
}
