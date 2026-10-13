import type { Check } from "../checks/types.ts";
import type { InstalledRepo } from "../github.ts";
import type { RepoSettings } from "../settings.ts";

export interface AdminPageData {
	email?: string;
	checks: Check[];
	rows: { repo: InstalledRepo; settings: RepoSettings }[];
	/** Repository whose checks start expanded, after a change made inside it. */
	open?: string | null;
}

const INSTALL_URL = "https://github.com/apps/quality-flare/installations/new";

export function renderAdminPage({ email, checks, rows, open }: AdminPageData): string {
	const list = rows.length
		? `<ul class="repos">${rows.map(({ repo, settings }) => renderRepo(repo, settings, checks, repo.full_name === open)).join("")}</ul>`
		: `<p class="empty">A App ainda não está instalada em nenhum repositório. <a href="${INSTALL_URL}">Instalar</a></p>`;
	return layout(
		"Repositórios",
		`${renderHeader(email, "repos")}
		<main>
			<h2>Repositórios</h2>
			<p class="hint">Repositórios e checks começam desativados. Ative o repositório e depois os checks que ele deve rodar. Um check desativado num repositório ativo aparece na PR como <em>neutral</em>, para não travar branches que o exigem.</p>
			${list}
			<p class="hint"><a href="${INSTALL_URL}">Conectar outros repositórios</a></p>
		</main>`,
	);
}

/** The admin's top bar: name, the two sections, and who is signed in. */
export function renderHeader(email: string | undefined, current: "repos" | "runs"): string {
	const link = (href: string, id: typeof current, text: string) =>
		`<a href="${href}"${id === current ? ' aria-current="page"' : ""}>${text}</a>`;
	return `<header>
			<h1>quality-flare</h1>
			<nav>${link("/admin", "repos", "Repositórios")}${link("/admin/runs", "runs", "Execuções de testes")}</nav>
			${email ? `<span class="who">${esc(email)}</span>` : ""}
		</header>`;
}

function renderRepo(repo: InstalledRepo, settings: RepoSettings, checks: Check[], open: boolean): string {
	const active = checks.filter((c) => settings.enabledChecks.has(c.id)).length;
	const items = checks
		.map(
			(check) => `<li>
				<span>${esc(check.name)}</span>
				${toggle("/admin/checks", { repo: repo.full_name, check: check.id }, settings.enabledChecks.has(check.id), `${check.name} em ${repo.full_name}`)}
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
					${button("/admin/checks/all", { repo: repo.full_name, enabled: "true" }, "Ativar todos")}
					${button("/admin/checks/all", { repo: repo.full_name, enabled: "false" }, "Desativar todos")}
					<a href="${esc(repo.html_url)}">Abrir no GitHub</a>
				</div>
				<ul class="checks">${items}</ul>
			</div>
		</details>
		<div class="repo-toggle">
			${toggle("/admin/repos", { repo: repo.full_name }, settings.enabled, `Ativar checks em ${repo.full_name}`, "Ativar checks")}
		</div>
	</li>`;
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

function button(action: string, fields: Record<string, string>, text: string): string {
	return `<form method="post" action="${action}">${hidden(fields)}<button type="submit" class="secondary">${esc(text)}</button></form>`;
}

function hidden(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
		.join("");
}

export function renderMessage(title: string, detail: string): string {
	return layout(title, `<main><h2>${esc(title)}</h2>${detail ? `<p>${esc(detail)}</p>` : ""}</main>`);
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
	header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	h1 { font-size: 16px; margin: 0; }
	nav { display: flex; gap: 16px; margin-right: auto; font-size: 14px; }
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
	.empty { padding: 24px 0; }
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
