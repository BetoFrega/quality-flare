import type { Check } from "../checks/types.ts";
import type { InstalledRepo } from "../github.ts";
import type { RepoSettings } from "../settings.ts";
import { RUN_COMMAND } from "../on-demand.ts";
import { DOCS_PATH, OFFICIAL_URL } from "../site.ts";

export interface AdminPageData {
	email?: string;
	checks: Check[];
	rows: { repo: InstalledRepo; settings: RepoSettings }[];
	/** Repository whose checks start expanded, after a change made inside it. */
	open?: string | null;
	query?: RepoQuery;
	/** The App's page for installing it on more repositories. */
	installUrl?: string;
	/** The deploy left the Tests checks out: the account has no Workers Paid plan. */
	testsOff?: boolean;
}

export type RepoStatus = "enabled" | "disabled";
export type RepoSort = "name" | "name-desc" | "enabled" | "checks";
const REPO_STATUSES: RepoStatus[] = ["enabled", "disabled"];
const REPO_SORTS: RepoSort[] = ["name", "name-desc", "enabled", "checks"];
const SORT_LABEL: Record<RepoSort, string> = {
	name: "Name (A–Z)",
	"name-desc": "Name (Z–A)",
	enabled: "Enabled first",
	checks: "Most checks enabled",
};

export interface RepoQuery {
	/** Part of the repository's name, any case. */
	q?: string;
	status?: RepoStatus;
	sort?: RepoSort;
}

/** Reads the repository list's filter and sort from the query string, ignoring values it doesn't know. */
export function repoQuery(params: URLSearchParams): RepoQuery {
	return {
		q: params.get("q")?.trim() || undefined,
		status: REPO_STATUSES.find((s) => s === params.get("status")),
		sort: REPO_SORTS.find((s) => s === params.get("sort")),
	};
}

/** The query string that brings the list back to `query`, with a leading "?" when not empty. */
export function repoSearch(query: RepoQuery, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries({ ...query, ...extra })) if (value) params.set(key, value);
	const search = params.toString();
	return search ? `?${search}` : "";
}

type Row = AdminPageData["rows"][number];

function filterRows(rows: Row[], checks: Check[], { q, status, sort = "name" }: RepoQuery): Row[] {
	const needle = q?.toLowerCase();
	const active = (row: Row) => checks.filter((c) => row.settings.enabledChecks.has(c.id)).length;
	const byName = (a: Row, b: Row) => a.repo.full_name.localeCompare(b.repo.full_name);
	const order: Record<RepoSort, (a: Row, b: Row) => number> = {
		name: byName,
		"name-desc": (a, b) => byName(b, a),
		enabled: (a, b) => Number(b.settings.enabled) - Number(a.settings.enabled) || byName(a, b),
		checks: (a, b) => active(b) - active(a) || byName(a, b),
	};
	return rows
		.filter((row) => !needle || row.repo.full_name.toLowerCase().includes(needle))
		.filter((row) => !status || row.settings.enabled === (status === "enabled"))
		.sort(order[sort]);
}

/** Without the App's own link: the Apps installed on the person's account. */
const INSTALLATIONS_URL = "https://github.com/settings/installations";

/** Why the Tests checks are missing, on the admin and /setup. */
export const TESTS_OFF_NOTE =
	'The Tests and Container tests checks are off: the Cloudflare account does not have Workers Paid, which they need. After you subscribe to <a href="https://dash.cloudflare.com/?to=/:account/workers/plans">Workers Paid</a>, run the build again (Deployments → Retry build) to turn them on.';

export function renderAdminPage({ email, checks, rows, open, query = {}, installUrl = INSTALLATIONS_URL, testsOff = false }: AdminPageData): string {
	const shown = filterRows(rows, checks, query);
	const back = repoSearch(query).slice(1);
	const filtered = Boolean(query.q || query.status);
	const list = shown.length
		? `<ul class="repos">${shown.map(({ repo, settings }) => renderRepo(repo, settings, checks, repo.full_name === open, back)).join("")}</ul>`
		: rows.length
			? `<p class="empty">No repositories match these filters. <a href="/admin">Clear filters</a></p>`
			: `<p class="empty">The App is not installed on any repository yet. <a href="${esc(installUrl)}">Install</a></p>`;
	const filters = rows.length
		? `<form class="filters" method="get" action="/admin">
				<label>Name <input type="search" name="q" value="${esc(query.q ?? "")}" placeholder="owner/repo"></label>
				${select("status", "Status", query.status ?? "", [["", "All"], ["enabled", "Enabled"], ["disabled", "Disabled"]])}
				${select("sort", "Sort", query.sort ?? "name", REPO_SORTS.map((s): [string, string] => [s, SORT_LABEL[s]]))}
				<button type="submit" class="secondary">Apply</button>
				${back ? '<a href="/admin">Clear</a>' : ""}
				${filtered ? `<span class="count">${shown.length} of ${rows.length}</span>` : ""}
			</form>`
		: "";
	return layout(
		"Repositories",
		`${renderHeader(email, "repos")}
		<main>
			<h2>Repositories</h2>
			${testsOff ? `<p class="hint">${TESTS_OFF_NOTE}</p>` : ""}
			<p class="hint">Repositories and checks start disabled. Enable the repository, then the checks it should run. A disabled check on an enabled repository shows on the PR as <em>neutral</em>, so it does not block branches that require it.</p>
			${filters}
			${list}
			<p class="hint"><a href="${esc(installUrl)}">Connect more repositories</a></p>
		</main>`,
	);
}

/** The admin's top bar: name, its sections, links to the docs and the project's site, and who is signed in. */
export function renderHeader(email: string | undefined, current: "repos" | "runs" | "costs"): string {
	const link = (href: string, id: typeof current, text: string) =>
		`<a href="${href}"${id === current ? ' aria-current="page"' : ""}>${text}</a>`;
	return `<header>
			<h1>quality-flare</h1>
			<nav>${link("/admin", "repos", "Repositories")}${link("/admin/runs", "runs", "Test runs")}${link("/admin/costs", "costs", "Costs")}<a href="${DOCS_PATH}">Docs</a><a href="${OFFICIAL_URL}">Site</a></nav>
			${email ? `<span class="who">${esc(email)}</span>` : ""}
		</header>`;
}

/** `back` is the list's filter and sort, so a change made through a form returns to the same view. */
function renderRepo(repo: InstalledRepo, settings: RepoSettings, checks: Check[], open: boolean, back: string): string {
	const fields = (extra: Record<string, string>) => ({ repo: repo.full_name, ...extra, ...(back ? { back } : {}) });
	const active = checks.filter((c) => settings.enabledChecks.has(c.id)).length;
	const items = checks
		.map(
			(check) => `<li>
				<span>${esc(check.name)}</span>
				${toggle("/admin/checks", fields({ check: check.id }), settings.enabledChecks.has(check.id), `${check.name} on ${repo.full_name}`)}
			</li>`,
		)
		.join("");
	return `<li class="repo${settings.enabled ? "" : " off"}" id="${esc(repo.full_name)}">
		<details${open ? " open" : ""}>
			<summary>
				<span class="name">${esc(repo.full_name)}</span>${repo.private ? ' <span class="badge">private</span>' : ""}
				<span class="count">${active} of ${checks.length} ${checks.length === 1 ? "check enabled" : "checks enabled"}</span>
			</summary>
			<div class="body">
				${settings.enabled ? "" : '<p class="note">Checks only run after the repository is enabled.</p>'}
				<div class="bulk">
					${button("/admin/checks/all", fields({ enabled: "true" }), "Enable all")}
					${button("/admin/checks/all", fields({ enabled: "false" }), "Disable all")}
					<a href="${esc(repo.html_url)}">Open on GitHub</a>
				</div>
				<ul class="checks">${items}</ul>
				${onDemandToggle(settings.onDemand, fields({}), checks, repo.full_name)}
			</div>
		</details>
		<div class="repo-toggle">
			${toggle("/admin/repos", fields({}), settings.enabled, `Enable checks on ${repo.full_name}`, "Enable checks")}
		</div>
	</li>`;
}

/** Turns on or off whether the test checks wait for a run command on this repository. */
function onDemandToggle(on: boolean, fields: Record<string, string>, checks: Check[], repo: string): string {
	const names = checks.filter((c) => c.onDemand).map((c) => c.name);
	if (!names.length) return "";
	return `<div class="on-demand">
		<div class="row">
			<span>On-demand tests</span>
			${toggle("/admin/on-demand", fields, on, `On-demand tests on ${repo}`)}
		</div>
		<p class="note">When on, ${esc(names.join(" and "))} wait on each push until someone from the repository comments <code>${esc(RUN_COMMAND)}</code> on the PR, which runs the current commit. PRs from bots, such as Dependabot, run right away.</p>
	</div>`;
}

/** A switch that posts the opposite of its current state. */
function toggle(action: string, fields: Record<string, string>, on: boolean, label: string, text = on ? "Enabled" : "Disabled"): string {
	return `<form method="post" action="${action}">
		${hidden({ ...fields, enabled: on ? "false" : "true" })}
		<button type="submit" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}">
			<span class="track"><span class="thumb"></span></span><span class="label">${esc(text)}</span>
		</button>
	</form>`;
}

function button(action: string, fields: Record<string, string>, text: string): string {
	return `<form method="post" action="${action}">${hidden(fields)}<button type="submit" class="secondary">${esc(text)}</button></form>`;
}

function hidden(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
		.join("");
}

/** A labelled drop-down for the filter bars, with `value` selected. */
export function select(name: string, label: string, value: string, options: [string, string][]): string {
	return `<label>${esc(label)} <select name="${esc(name)}">${options
		.map(([v, text]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(text)}</option>`)
		.join("")}</select></label>`;
}

export function renderMessage(title: string, detail: string): string {
	return layout(title, `<main><h2>${esc(title)}</h2>${detail ? `<p>${esc(detail)}</p>` : ""}</main>`);
}

export function layout(title: string, body: string, head = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · quality-flare</title>
${head}
<style>
	:root { --bg: #fff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --panel: #f6f8fa; --on: #1a7f37; --off: #818b98; --link: #0969da; color-scheme: light dark; }
	@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #f0f6fc; --muted: #9198a1; --line: #3d444d; --panel: #151b23; --on: #3fb950; --off: #656c76; --link: #4493f8; } }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
	header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	h1 { font-size: 16px; margin: 0; }
	nav { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-right: auto; font-size: 14px; }
	nav a { color: var(--muted); text-decoration: none; }
	nav a[aria-current] { color: var(--fg); font-weight: 600; }
	table { width: 100%; border-collapse: collapse; font-size: 14px; }
	th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
	th { color: var(--muted); font-weight: 500; font-size: 13px; }
	.num { text-align: right; white-space: nowrap; }
	.mono { font-family: ui-monospace, monospace; font-size: 13px; }
	.state { white-space: nowrap; font-weight: 600; }
	.success { color: var(--on); } .failure { color: #cf222e; } .neutral, .cancelled, .skip { color: var(--muted); } .running { color: #9a6700; }
	.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); font-size: 13px; margin: 0 0 20px; }
	h3 { font-size: 15px; margin: 24px 0 6px; overflow-wrap: anywhere; }
	pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 12px; margin: 6px 0 0; white-space: pre-wrap; }
	.tests li { padding: 4px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
	h2 { font-size: 20px; margin: 0 0 4px; }
	main { max-width: 860px; margin: 0 auto; padding: 24px 16px; }
	a { color: var(--link); }
	.who, .hint, .count, .note { color: var(--muted); font-size: 13px; }
	.who { overflow-wrap: anywhere; text-align: right; }
	.hint { margin: 0 0 16px; }
	ul { list-style: none; margin: 0; padding: 0; }
	.repos { border-top: 1px solid var(--line); margin-bottom: 16px; }
	.repo { position: relative; border-bottom: 1px solid var(--line); }
	summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding: 14px 170px 14px 22px; cursor: pointer; list-style: none; position: relative; }
	summary::-webkit-details-marker { display: none; }
	summary::before { content: ""; position: absolute; left: 4px; top: 21px; border: 5px solid transparent; border-left-color: var(--muted); transition: transform .15s; transform-origin: 2px 5px; }
	details[open] summary::before { transform: rotate(90deg); }
	summary:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
	.name { font-weight: 600; word-break: break-all; }
	.repo.off .name { color: var(--muted); }
	.badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; }
	.count { margin-left: auto; }
	.repo-toggle { position: absolute; top: 9px; right: 0; }
	.body { margin: 0 0 14px 22px; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
	.note { margin: 0 0 8px; }
	.bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 8px; font-size: 13px; }
	.bulk a { margin-left: auto; }
	.checks li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
	.repo.off .checks { opacity: .6; }
	form { margin: 0; }
	button { font: inherit; color: var(--fg); cursor: pointer; }
	button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
	.secondary { font-size: 13px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
	.secondary:hover { border-color: var(--muted); }
	.switch { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; padding: 4px 0; border-radius: 4px; }
	.track { flex: none; width: 34px; height: 20px; border-radius: 999px; background: var(--off); position: relative; transition: background .15s; }
	.thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
	.switch[aria-checked="true"] .track { background: var(--on); }
	.switch[aria-checked="true"] .thumb { left: 16px; }
	.on-demand { padding: 6px 0 0; border-top: 1px solid var(--line); }
	.on-demand .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
	.on-demand .note { margin: 0; }
	.empty { padding: 24px 0; }
	.scroll { overflow-x: auto; }
	.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin: 0 0 12px; }
	.stats div { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
	.stats dt { color: var(--muted); font-size: 12px; }
	.stats dd { margin: 0; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
	details.plain summary { padding: 6px 0 6px 18px; font-size: 14px; color: var(--muted); }
	details.plain summary::before { top: 13px; }
	h2 + .stats, .usage { margin-top: 12px; }
	.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 8px 12px; margin: 0 0 16px; font-size: 13px; }
	.filters label { display: flex; flex-direction: column; gap: 2px; color: var(--muted); }
	.filters input, .filters select { font: inherit; font-size: 14px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
	.filters input { width: 180px; }
	.filters a, .filters .count { align-self: center; }
	@media (max-width: 560px) {
		summary { padding-right: 56px; }
		.count { margin-left: 0; flex-basis: 100%; }
		.repo-toggle .label { display: none; }
		.body { margin-left: 0; }
	}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function esc(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
