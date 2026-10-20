import type { Check } from "../checks/types.ts";
import type { InstalledRepo } from "../github.ts";
import type { RepoSettings } from "../settings.ts";
import { RUN_COMMAND } from "../on-demand.ts";
import { DOCS_PATH, FAVICON, MARK, OFFICIAL_URL } from "../site.ts";

export interface AdminPageData {
	email?: string;
	checks: Check[];
	rows: { repo: InstalledRepo; settings: RepoSettings }[];
	/** Repository whose checks start expanded, after a change made inside it. */
	open?: string | null;
	/** The control a change was just made through (see controlId), to confirm it next to that control. */
	changed?: string | null;
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

export function renderAdminPage({ email, checks, rows, open, changed, query = {}, installUrl = INSTALLATIONS_URL, testsOff = false }: AdminPageData): string {
	const shown = filterRows(rows, checks, query);
	const back = repoSearch(query).slice(1);
	const filtered = Boolean(query.q || query.status);
	const list = shown.length
		? `<ul class="repos">${shown.map(({ repo, settings }) => renderRepo(repo, settings, checks, repo.full_name === open, back, changed)).join("")}</ul>`
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

/**
 * The admin's top bar: name, its sections, and, apart and quieter, links that leave the
 * admin (the docs and the project's site), then who is signed in. Without `current`, as on
 * error pages, no section is marked.
 */
export function renderHeader(email: string | undefined, current?: "repos" | "runs" | "costs"): string {
	const link = (href: string, id: typeof current, text: string) =>
		`<a href="${href}"${id === current ? ' aria-current="page"' : ""}>${text}</a>`;
	const external = (href: string, text: string) => `<a href="${href}">${text}<span aria-hidden="true"> ↗</span></a>`;
	return `<header>
			<h1>${MARK}quality-flare</h1>
			<nav class="sections" aria-label="Sections">${link("/admin", "repos", "Repositories")}${link("/admin/runs", "runs", "Test runs")}${link("/admin/costs", "costs", "Costs")}</nav>
			<nav class="external" aria-label="External links">${external(DOCS_PATH, "Docs")}${external(OFFICIAL_URL, "Site")}</nav>
			${email ? `<span class="who" title="${esc(email)}">${esc(email)}</span>` : ""}
		</header>`;
}

/**
 * The id of a control on the admin page, which a change made through it redirects back to.
 * `control` is "repo", "check:<id>", "on-demand", or "checks" (the list, after "Enable/Disable all").
 */
export function controlId(repo: string, control: string): string {
	return `${repo}:${control}`;
}

/** Turning a whole repository off makes the Worker ignore its webhooks, so no check run is created at all. */
const REPO_OFF_WARNING =
	"Disabling the repository stops all of its check runs: a check that branch protection requires stays pending and blocks merging PRs. To pause without blocking, use “Disable all”: the checks then answer neutral.";

/**
 * `back` is the list's filter and sort, so a change made through a form returns to the same view.
 * `changed` is the control a change was just made through, confirmed next to it.
 */
function renderRepo(repo: InstalledRepo, settings: RepoSettings, checks: Check[], open: boolean, back: string, changed?: string | null): string {
	const fields = (extra: Record<string, string>) => ({ repo: repo.full_name, ...extra, ...(back ? { back } : {}) });
	const id = (control: string) => controlId(repo.full_name, control);
	const active = checks.filter((c) => settings.enabledChecks.has(c.id)).length;
	const count = settings.enabled
		? `${active} of ${checks.length} ${checks.length === 1 ? "check enabled" : "checks enabled"}`
		: "no checks run: repository disabled";
	const warningId = id("warning");
	const listId = id("checks");
	const items = checks
		.map(
			(check) => `<li>
				<span>${esc(check.name)}</span>
				${toggle("/admin/checks", fields({ check: check.id }), settings.enabledChecks.has(check.id), `${check.name} on ${repo.full_name}`, id(`check:${check.id}`), changed)}
			</li>`,
		)
		.join("");
	const listSaved = changed === listId
		? `<p class="saved" role="status" id="${esc(listId)}-status">Saved: ${active} of ${checks.length} checks enabled.</p>`
		: "";
	return `<li class="repo${settings.enabled ? "" : " off"}" id="${esc(repo.full_name)}">
		<details${open ? " open" : ""}>
			<summary>
				<span class="name">${esc(repo.full_name)}</span>${repo.private ? ' <span class="badge">private</span>' : ""}
				<span class="count">${count}</span>
			</summary>
			<div class="body">
				${settings.enabled
					? `<p class="note warn" id="${esc(warningId)}">${REPO_OFF_WARNING}</p>`
					: '<p class="note">Checks only run after the repository is enabled.</p>'}
				<div class="bulk">
					${button("/admin/checks/all", fields({ enabled: "true" }), "Enable all", `Enable all checks on ${repo.full_name}`)}
					${button("/admin/checks/all", fields({ enabled: "false" }), "Disable all", `Disable all checks on ${repo.full_name}`)}
					<span class="links">
						<a href="/admin/runs?repo=${esc(encodeURIComponent(repo.full_name))}" aria-label="${esc(`Test runs of ${repo.full_name}`)}">Test runs</a>
						<a href="/admin/costs?repo=${esc(encodeURIComponent(repo.full_name))}" aria-label="${esc(`Costs of ${repo.full_name}`)}">Costs</a>
						<a href="${esc(repo.html_url)}" aria-label="${esc(`Open ${repo.full_name} on GitHub`)}">Open on GitHub</a>
					</span>
				</div>
				${listSaved}
				<ul class="checks" id="${esc(listId)}" tabindex="-1"${listSaved ? ` aria-describedby="${esc(listId)}-status"` : ""}>${items}</ul>
				${onDemandToggle(settings.onDemand, fields({}), checks, repo.full_name, id("on-demand"), changed)}
			</div>
		</details>
		<div class="repo-toggle">
			${toggle("/admin/repos", fields({}), settings.enabled, `Enable checks on ${repo.full_name}`, id("repo"), changed, settings.enabled ? { title: REPO_OFF_WARNING, describedBy: warningId } : {})}
		</div>
	</li>`;
}

/** Turns on or off whether the test checks wait for a run command on this repository. */
function onDemandToggle(on: boolean, fields: Record<string, string>, checks: Check[], repo: string, id: string, changed?: string | null): string {
	const names = checks.filter((c) => c.onDemand).map((c) => c.name);
	if (!names.length) return "";
	return `<div class="on-demand">
		<div class="row">
			<span>On-demand tests</span>
			${toggle("/admin/on-demand", fields, on, `On-demand tests on ${repo}`, id, changed)}
		</div>
		<p class="note">When on, ${esc(names.join(" and "))} wait on each push until someone from the repository comments <code>${esc(RUN_COMMAND)}</code> on the PR, which runs the current commit. PRs from bots, such as Dependabot, run right away.</p>
	</div>`;
}

/**
 * A switch that posts the opposite of its current state. The change redirects to `#id`, which
 * focuses the switch again; when `changed` names it, a status line confirms the new state.
 */
function toggle(
	action: string,
	fields: Record<string, string>,
	on: boolean,
	label: string,
	id: string,
	changed?: string | null,
	{ title, describedBy }: { title?: string; describedBy?: string } = {},
): string {
	const saved = changed === id;
	const statusId = `${id}-status`;
	const described = [describedBy, saved ? statusId : undefined].filter(Boolean).join(" ");
	return `<form method="post" action="${action}">
		${hidden({ ...fields, enabled: on ? "false" : "true" })}
		<button type="submit" class="switch" id="${esc(id)}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"${described ? ` aria-describedby="${esc(described)}"` : ""}${title ? ` title="${esc(title)}"` : ""}>
			<span class="track"><span class="thumb"></span></span><span class="label">${on ? "Enabled" : "Disabled"}</span>
		</button>
		${saved ? `<span class="saved" role="status" id="${esc(statusId)}">Saved</span>` : ""}
	</form>`;
}

function button(action: string, fields: Record<string, string>, text: string, label: string): string {
	return `<form method="post" action="${action}">${hidden(fields)}<button type="submit" class="secondary" aria-label="${esc(label)}">${esc(text)}</button></form>`;
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

/**
 * A page with only a title and a short explanation. With `shell`, for someone already signed
 * in, it keeps the admin's header so the page isn't a dead end; `back` adds a way out to the
 * repository list. Without it, as before Access lets the person in, no admin navigation shows.
 */
export function renderMessage(title: string, detail: string, shell?: { email?: string; back?: boolean }): string {
	const text = `<h2>${esc(title)}</h2>${detail ? `<p>${esc(detail)}</p>` : ""}`;
	if (!shell) return layout(title, `<main>${text}</main>`);
	const back = shell.back ? '<p><a href="/admin">Back to Repositories</a></p>' : "";
	return layout(title, `${renderHeader(shell.email)}<main>${text}${back}</main>`);
}

export function layout(title: string, body: string, head = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · quality-flare</title>
${FAVICON}
${head}
<style>
	:root { --bg: #fff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --panel: #f6f8fa; --on: #1a7f37; --off: #818b98; --link: #0969da; --failure: #cf222e; --running: #9a6700; color-scheme: light dark; }
	@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #f0f6fc; --muted: #9198a1; --line: #3d444d; --panel: #151b23; --on: #3fb950; --off: #656c76; --link: #4493f8; --failure: #f85149; --running: #d29922; } }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
	header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	h1 { display: flex; align-items: center; gap: 10px; flex-shrink: 0; white-space: nowrap; font-size: 16px; margin: 0; }
	.mark { width: 24px; height: 24px; }
	.mark-flare { fill: #c2410c; }
	@media (prefers-color-scheme: dark) { .mark-flare { fill: #fb8c4a; } }
	nav { display: flex; gap: 16px; font-size: 14px; }
	nav a { color: var(--muted); text-decoration: none; text-underline-offset: 6px; text-decoration-thickness: 2px; }
	nav a:hover { color: var(--fg); text-decoration-line: underline; }
	.sections { margin-right: auto; }
	.sections a[aria-current] { color: var(--fg); font-weight: 600; text-decoration-line: underline; }
	.external { gap: 12px; font-size: 13px; }
	table { width: 100%; border-collapse: collapse; font-size: 14px; }
	th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
	th { color: var(--muted); font-weight: 500; font-size: 13px; }
	.num { text-align: right; white-space: nowrap; }
	.mono { font-family: ui-monospace, monospace; font-size: 13px; }
	.state { white-space: nowrap; font-weight: 600; }
	.success { color: var(--on); } .failure { color: var(--failure); } .neutral, .cancelled, .skip { color: var(--muted); } .running { color: var(--running); } .overdue { color: var(--failure); }
	.state a { color: inherit; }
	.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); font-size: 13px; margin: 0 0 20px; }
	h3 { font-size: 15px; margin: 24px 0 6px; overflow-wrap: anywhere; }
	pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 12px; margin: 6px 0 0; white-space: pre-wrap; }
	.tests li { padding: 4px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
	h2 { font-size: 20px; margin: 0 0 4px; }
	main { max-width: 860px; margin: 0 auto; padding: 24px 16px; }
	a { color: var(--link); }
	.who, .hint, .count, .note { color: var(--muted); font-size: 13px; }
	.who { max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
	.repo-toggle { position: absolute; top: 7px; right: 0; }
	.body { margin: 0 0 14px 22px; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
	.note { margin: 0 0 8px; }
	.warn { color: var(--fg); padding: 6px 10px; border: 1px solid var(--running); border-radius: 6px; }
	.bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 8px; font-size: 13px; }
	.bulk .links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-left: auto; }
	.checks li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 2px 0; border-top: 1px solid var(--line); }
	.repo.off .checks { opacity: .6; }
	form { margin: 0; }
	button { font: inherit; color: var(--fg); cursor: pointer; }
	button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
	.secondary { font-size: 13px; min-height: 36px; padding: 3px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
	.secondary:hover { border-color: var(--muted); }
	.switch { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; background: none; border: 0; padding: 0 4px; border-radius: 4px; }
	.repo-toggle form, .checks form, .on-demand form { display: flex; align-items: center; gap: 8px; }
	.saved { color: var(--on); font-size: 13px; }
	.checks:focus { outline: none; }
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
	.costs .hint { max-width: 70ch; }
	.costs h4 { font-size: 14px; margin: 20px 0 6px; }
	.costs details.plain > .hint { margin: 2px 0 12px 18px; }
	.lead { margin: 12px 0; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
	.lead.over .verdict { color: var(--failure); }
	.lead .verdict { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
	.lead .hint { margin: 0; }
	.toc { margin: 0 0 8px; font-size: 13px; }
	.toc a { color: var(--link); }
	.meters { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
	.meters dd { font-size: 15px; }
	.meters .pct { font-size: 13px; margin-left: 4px; }
	.meters meter { display: block; width: 100%; height: 8px; margin-top: 6px; }
	@media (max-width: 560px) {
		header { justify-content: space-between; }
		.sections { order: 1; flex-basis: 100%; }
		.who { display: none; }
		summary { padding-right: 56px; }
		.count { margin-left: 0; flex-basis: 100%; }
		.repo-toggle { top: 3px; }
		.repo-toggle .label, .repo-toggle .saved { display: none; }
		.switch, .secondary { min-height: 44px; }
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
