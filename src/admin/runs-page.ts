import { RUN_SORTS, RUN_STATES, runState, STALE_AFTER_MS, type RunQuery, type RunSort, type TestRun, type TestRunDetail } from "../runs.ts";
import { RUN_DEADLINE_MS } from "../checks/tests/index.ts";
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
	const late = runs.some((r) => overdue(r, now));
	const rows = runs
		.map((run) => {
			const s = runState(run, now);
			return `<tr>
				<td class="${stateClass(run, now)}"><a href="/admin/runs/${run.id}">${stateLabel(run, now)}</a></td>
				<td>${run.container ? "Container tests" : "Tests"}</td>
				<td>${target(run)} <span class="mono">${esc(run.sha.slice(0, 7))}</span></td>
				<td>${s === "running" ? `<span data-progress="${run.id}" role="status" aria-live="polite">Preparing…</span>` : esc(run.title ?? "")}</td>
				<td class="num">${when(run.startedAt, now)}</td>
				<td class="num">${duration(run, now)}</td>
				${usageCells(usage.get(run.id), containers.get(run.id))}
			</tr>`;
		})
		.join("");
	const table = runs.length
		? `<div class="scroll"><table><thead><tr><th>Status</th><th>Check</th><th>Target</th><th>Result</th><th class="num">Started</th><th class="num">Duration</th><th class="num" title="Dynamic Workers created (and crashes)">Workers</th><th class="num">Est. cost</th></tr></thead><tbody>${rows}</tbody></table></div>`
		: filtered
			? `<p class="empty">No runs match these filters. <a href="/admin/runs">Clear filters</a></p>`
			: `<p class="empty">No runs yet. The Tests and Container tests checks run when they are enabled on a repository and a PR gets commits.</p>`;
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
			<p class="hint">The 50 most recent runs of the Tests and Container tests checks. The page follows running tests live.</p>
			${late ? `<p class="hint">${OVERDUE_HINT}</p>` : ""}
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
	// Failures first, each with the file it is in: a file's own errors (it didn't load), then its failing tests.
	const failures = files.flatMap((f) => [
		...(f.errors ?? []).map((e) => failure(f.path, "file error", [e])),
		...f.tests.filter((t) => t.state === "fail").map((t) => failure(f.path, t.name, t.errors ?? [])),
	]);
	const fileList = files
		.map((f) => {
			const passed = f.tests.filter((t) => t.state === "pass").length;
			const failed = Boolean(f.errors?.length || f.tests.some((t) => t.state === "fail"));
			return `<details class="plain"${failed ? " open" : ""}><summary><span class="state ${failed ? "failure" : "success"}">${icon(failed ? "failure" : "success")} ${failed ? LABEL.failure : LABEL.success}</span> <span class="mono">${esc(f.path)}</span> <span class="count">${passed}/${f.tests.length} passed</span></summary>
				<ul class="tests">${f.tests.map((t) => `<li>${testIcon(t.state)} ${esc(t.name)}</li>`).join("")}</ul>
			</details>`;
		})
		.join("");
	const report = `${failures.length ? `<h3>Failures</h3><ul class="tests">${failures.join("")}</ul>` : ""}<h3>Files</h3>${fileList}`;
	const body =
		s === "running"
			? `<p data-progress="${run.id}" role="status" aria-live="polite">Preparing the tests…</p><ul class="tests" data-tests="${run.id}"></ul>`
			: s === "stale"
				? "<p>The run stopped before it finished: the Worker stopped (memory or time limit) without recording the result. Nothing is still running. Run it again with <strong>Re-run</strong> on the PR.</p>"
				: files.length
					? report
					: `<pre>${esc(run.summary ?? "")}</pre>`;
	return layout(
		`Run ${run.id}`,
		`${renderHeader(email, "runs")}
		<main${s === "running" ? ` data-live="${run.id}"` : ""}>
			<p class="hint"><a href="/admin/runs">← Test runs</a></p>
			<h2 class="${stateClass(run, now)}">${s === "running" ? stateLabel(run, now) : `${icon(s)} ${esc(run.title ?? LABEL[s])}`}</h2>
			<p class="meta">
				<span>${run.container ? "Container tests" : "Tests"}</span>
				${target(run)}
				${run.pr ? `<a class="mono" href="https://github.com/${esc(run.repo)}/commit/${esc(run.sha)}">${esc(run.sha)}</a>` : `<span class="mono">${esc(run.sha)}</span>`}
				<span>${when(run.startedAt, now)}</span>
				<span>${duration(run, now)}</span>
			</p>
			${overdue(run, now) ? `<p class="hint">${OVERDUE_HINT}</p>` : ""}
			${body}
			${renderUsage(usage, attempts, now, s !== "running", container)}
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

/** A state's icon, hidden from screen readers: the label next to it says the same. */
const icon = (s: State) => `<span aria-hidden="true">${ICON[s]}</span>`;

/** A test's icon, the only sign of its state, so it is read out as one. */
function testIcon(state: string): string {
	const [s, css, label] = state === "pass" ? (["success", "success", "passed"] as const) : state === "fail" ? (["failure", "failure", "failed"] as const) : (["neutral", "skip", "skipped"] as const);
	return `<span class="state ${css}" role="img" aria-label="${label}">${ICON[s]}</span>`;
}

function failure(file: string, name: string, errors: string[]): string {
	return `<li>${testIcon("fail")} <span class="mono">${esc(file)}</span> › ${esc(name)}${errors.map((e) => `<pre>${esc(e)}</pre>`).join("")}</li>`;
}

/**
 * A run past its deadline should already have been failed by the cron (src/checks/tests/index.ts);
 * until it shows as interrupted (STALE_AFTER_MS), it is flagged as probably stuck.
 */
const overdue = (run: TestRun, now: number) => runState(run, now) === "running" && now - run.startedAt > RUN_DEADLINE_MS;

const OVERDUE_HINT = `A run going for more than ${RUN_DEADLINE_MS / 60_000} min is past its deadline and probably stuck. At ${STALE_AFTER_MS / 60_000} min it shows as interrupted.`;

const stateClass = (run: TestRun, now: number) => `state ${runState(run, now)}${overdue(run, now) ? " overdue" : ""}`;

/** The state's icon and label; a running run also says for how long, and whether it is past its deadline. */
function stateLabel(run: TestRun, now: number): string {
	const s = runState(run, now);
	if (s !== "running") return `${icon(s)} ${LABEL[s]}`;
	const min = Math.floor((now - run.startedAt) / 60_000);
	return `${icon(s)} ${LABEL[s]}${min ? ` for ${min} min` : ""}${overdue(run, now) ? " · past deadline" : ""}`;
}

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

/** The run page's one usage section: the Dynamic Workers' (from the costs page), then the container's. */
function renderUsage(u: Usage | undefined, attempts: AttemptRow[], now: number, over: boolean, container: BoxUsage | undefined): string {
	const workers = renderRunUsage(u, attempts, now, over);
	if (!container) return workers;
	// The container's numbers go under the workers' heading when there is one.
	return workers ? `${workers}${containerStats(container)}` : `<section class="usage"><h3>Usage and cost</h3>${containerStats(container)}</section>`;
}

/** Usage of a run on the "Container" runner. */
function containerStats(u: BoxUsage): string {
	const size = instanceSize(u.instance);
	const items: [string, string][] = [
		["Estimated cost", money(boxCost(u))],
		["Container", `${u.instance ?? DEFAULT_INSTANCE} (${size.vcpu} vCPU, ${size.memoryGiB} GiB)`],
		["Time on", cpu(u.wallMs)],
		["CPU used", u.cpuUs === undefined ? "—" : cpu(Math.round(u.cpuUs / 1000))],
	];
	return `<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
		<p class="hint">Estimate without the monthly allowance: memory and disk for the time it was on, CPU for what it used.</p>`;
}

/** The PR a run tested, or the commit for a full run, which has none (pr 0). */
function target(run: Pick<TestRun, "repo" | "pr" | "sha">): string {
	if (!run.pr) return `<a href="https://github.com/${esc(run.repo)}/commit/${esc(run.sha)}">${esc(run.repo)} (full run)</a>`;
	return `<a href="https://github.com/${esc(run.repo)}/pull/${run.pr}">${esc(run.repo)}#${run.pr}</a>`;
}
