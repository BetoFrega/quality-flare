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
	name: "Nome (A–Z)",
	"name-desc": "Nome (Z–A)",
	enabled: "Ativos primeiro",
	checks: "Mais checks ativos",
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
	'Os checks Tests e Container tests estão desligados: a conta Cloudflare não tem o Workers Paid, que eles exigem. Depois de assinar o <a href="https://dash.cloudflare.com/?to=/:account/workers/plans">Workers Paid</a>, rode o build de novo (Deployments → Retry build) para ligá-los.';

export function renderAdminPage({ email, checks, rows, open, query = {}, installUrl = INSTALLATIONS_URL, testsOff = false }: AdminPageData): string {
	const shown = filterRows(rows, checks, query);
	const back = repoSearch(query).slice(1);
	const filtered = Boolean(query.q || query.status);
	const list = shown.length
		? `<ul class="repos">${shown.map(({ repo, settings }) => renderRepo(repo, settings, checks, repo.full_name === open, back)).join("")}</ul>`
		: rows.length
			? `<p class="empty">Nenhum repositório com esses filtros. <a href="/admin">Limpar filtros</a></p>`
			: `<p class="empty">A App ainda não está instalada em nenhum repositório. <a href="${esc(installUrl)}">Instalar</a></p>`;
	const filters = rows.length
		? `<form class="filters" method="get" action="/admin">
				<label>Nome <input type="search" name="q" value="${esc(query.q ?? "")}" placeholder="owner/repo"></label>
				${select("status", "Estado", query.status ?? "", [["", "Todos"], ["enabled", "Ativos"], ["disabled", "Desativados"]])}
				${select("sort", "Ordenar", query.sort ?? "name", REPO_SORTS.map((s): [string, string] => [s, SORT_LABEL[s]]))}
				<button type="submit" class="secondary">Aplicar</button>
				${back ? '<a href="/admin">Limpar</a>' : ""}
				${filtered ? `<span class="count">${shown.length} de ${rows.length}</span>` : ""}
			</form>`
		: "";
	return layout(
		"Repositórios",
		`${renderHeader(email, "repos")}
		<main>
			<h2>Repositórios</h2>
			${testsOff ? `<p class="hint">${TESTS_OFF_NOTE}</p>` : ""}
			<p class="hint">Repositórios e checks começam desativados. Ative o repositório e depois os checks que ele deve rodar. Um check desativado num repositório ativo aparece na PR como <em>neutral</em>, para não travar branches que o exigem.</p>
			${filters}
			${list}
			<p class="hint"><a href="${esc(installUrl)}">Conectar outros repositórios</a></p>
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
			<h1>quality-flare</h1>
			<nav class="sections" aria-label="Seções">${link("/admin", "repos", "Repositórios")}${link("/admin/runs", "runs", "Execuções")}${link("/admin/costs", "costs", "Custos")}</nav>
			<nav class="external" aria-label="Links externos">${external(DOCS_PATH, "Docs")}${external(OFFICIAL_URL, "Site")}</nav>
			${email ? `<span class="who" title="${esc(email)}">${esc(email)}</span>` : ""}
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
				${toggle("/admin/checks", fields({ check: check.id }), settings.enabledChecks.has(check.id), `${check.name} em ${repo.full_name}`)}
			</li>`,
		)
		.join("");
	return `<li class="repo${settings.enabled ? "" : " off"}" id="${esc(repo.full_name)}">
		<details${open ? " open" : ""}>
			<summary>
				<span class="name">${esc(repo.full_name)}</span>${repo.private ? ' <span class="badge">privado</span>' : ""}
				<span class="count">${active} de ${checks.length} ${checks.length === 1 ? "check ativo" : "checks ativos"}</span>
			</summary>
			<div class="body">
				${settings.enabled ? "" : '<p class="note">Os checks só rodam depois que o repositório é ativado.</p>'}
				<div class="bulk">
					${button("/admin/checks/all", fields({ enabled: "true" }), "Ativar todos", `Ativar todos os checks em ${repo.full_name}`)}
					${button("/admin/checks/all", fields({ enabled: "false" }), "Desativar todos", `Desativar todos os checks em ${repo.full_name}`)}
					<span class="links">
						<a href="/admin/runs?repo=${esc(encodeURIComponent(repo.full_name))}" aria-label="${esc(`Execuções de ${repo.full_name}`)}">Execuções</a>
						<a href="/admin/costs?repo=${esc(encodeURIComponent(repo.full_name))}" aria-label="${esc(`Custos de ${repo.full_name}`)}">Custos</a>
						<a href="${esc(repo.html_url)}" aria-label="${esc(`Abrir ${repo.full_name} no GitHub`)}">Abrir no GitHub</a>
					</span>
				</div>
				<ul class="checks">${items}</ul>
				${onDemandToggle(settings.onDemand, fields({}), checks, repo.full_name)}
			</div>
		</details>
		<div class="repo-toggle">
			${toggle("/admin/repos", fields({}), settings.enabled, `Ativar checks em ${repo.full_name}`, "Ativar checks")}
		</div>
	</li>`;
}

/** Turns on or off whether the test checks wait for a run command on this repository. */
function onDemandToggle(on: boolean, fields: Record<string, string>, checks: Check[], repo: string): string {
	const names = checks.filter((c) => c.onDemand).map((c) => c.name);
	if (!names.length) return "";
	return `<div class="on-demand">
		<div class="row">
			<span>Testes sob demanda</span>
			${toggle("/admin/on-demand", fields, on, `Testes sob demanda em ${repo}`)}
		</div>
		<p class="note">Ligado, ${esc(names.join(" e "))} ficam em espera em cada push até alguém do repositório comentar <code>${esc(RUN_COMMAND)}</code> na PR, que roda o commit atual. PRs de bots, como o Dependabot, rodam direto.</p>
	</div>`;
}

/** A switch that posts the opposite of its current state. */
function toggle(action: string, fields: Record<string, string>, on: boolean, label: string, text = on ? "Ativo" : "Desativado"): string {
	return `<form method="post" action="${action}">
		${hidden({ ...fields, enabled: on ? "false" : "true" })}
		<button type="submit" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}">
			<span class="track"><span class="thumb"></span></span><span class="label">${esc(text)}</span>
		</button>
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
	const back = shell.back ? '<p><a href="/admin">Voltar para Repositórios</a></p>' : "";
	return layout(title, `${renderHeader(shell.email)}<main>${text}${back}</main>`);
}

export function layout(title: string, body: string, head = ""): string {
	return `<!doctype html>
<html lang="pt-BR">
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
	header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	h1 { font-size: 16px; margin: 0; }
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
	.success { color: var(--on); } .failure { color: #cf222e; } .neutral, .cancelled, .skip { color: var(--muted); } .running { color: #9a6700; }
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
	.repo-toggle { position: absolute; top: 9px; right: 0; }
	.body { margin: 0 0 14px 22px; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
	.note { margin: 0 0 8px; }
	.bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 8px; font-size: 13px; }
	.bulk .links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-left: auto; }
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
		header { justify-content: space-between; }
		.sections { order: 1; flex-basis: 100%; }
		.who { display: none; }
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
