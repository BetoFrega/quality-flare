import type { Check } from "../checks/types.ts";
import type { InstalledRepo } from "../github.ts";

export interface AdminPageData {
	email?: string;
	checks: Check[];
	rows: { repo: InstalledRepo; disabled: Set<string> }[];
}

const INSTALL_URL = "https://github.com/apps/quality-flare/installations/new";

export function renderAdminPage({ email, checks, rows }: AdminPageData): string {
	const table = rows.length
		? `<table>
			<thead><tr><th scope="col">Repositório</th>${checks.map((c) => `<th scope="col">${esc(c.name)}</th>`).join("")}</tr></thead>
			<tbody>${rows.map(({ repo, disabled }) => renderRow(repo, disabled, checks)).join("")}</tbody>
		</table>`
		: `<p class="empty">A App ainda não está instalada em nenhum repositório. <a href="${INSTALL_URL}">Instalar</a></p>`;
	return layout(
		"Checks por repositório",
		`<header>
			<h1>quality-flare</h1>
			${email ? `<span class="who">${esc(email)}</span>` : ""}
		</header>
		<main>
			<h2>Checks por repositório</h2>
			<p class="hint">Um check desativado continua aparecendo na PR como <em>neutral</em>, para não travar branches que o exigem.</p>
			${table}
			<p class="hint"><a href="${INSTALL_URL}">Conectar outros repositórios</a></p>
		</main>`,
	);
}

function renderRow(repo: InstalledRepo, disabled: Set<string>, checks: Check[]): string {
	const cells = checks.map((check) => {
		const on = !disabled.has(check.id);
		return `<td>
			<form method="post" action="/admin/checks">
				<input type="hidden" name="repo" value="${esc(repo.full_name)}">
				<input type="hidden" name="check" value="${esc(check.id)}">
				<input type="hidden" name="enabled" value="${on ? "false" : "true"}">
				<button type="submit" role="switch" aria-checked="${on}" aria-label="${esc(check.name)} em ${esc(repo.full_name)}">
					<span class="track"><span class="thumb"></span></span><span class="mobile">${esc(check.name)}: </span>${on ? "Ativo" : "Desativado"}
				</button>
			</form>
		</td>`;
	});
	return `<tr id="${esc(repo.full_name)}">
		<th scope="row"><a href="${esc(repo.html_url)}">${esc(repo.full_name)}</a>${repo.private ? ' <span class="badge">privado</span>' : ""}</th>
		${cells.join("")}
	</tr>`;
}

export function renderMessage(title: string, detail: string): string {
	return layout(title, `<main><h2>${esc(title)}</h2>${detail ? `<p>${esc(detail)}</p>` : ""}</main>`);
}

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · quality-flare</title>
<style>
	:root { --bg: #fff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --on: #1a7f37; --off: #818b98; --link: #0969da; color-scheme: light dark; }
	@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #f0f6fc; --muted: #9198a1; --line: #3d444d; --on: #3fb950; --off: #656c76; --link: #4493f8; } }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
	header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
	h1 { font-size: 16px; margin: 0; }
	h2 { font-size: 20px; margin: 0 0 4px; }
	main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
	a { color: var(--link); }
	.who, .hint { color: var(--muted); font-size: 13px; }
	.who { overflow-wrap: anywhere; text-align: right; }
	.hint { margin: 0 0 16px; }
	table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
	th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
	thead th { font-size: 13px; color: var(--muted); font-weight: 600; }
	tbody th { font-weight: 500; word-break: break-all; }
	.badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; }
	form { margin: 0; }
	button { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; padding: 4px 0; color: var(--fg); font: inherit; cursor: pointer; }
	.track { width: 34px; height: 20px; border-radius: 999px; background: var(--off); position: relative; transition: background .15s; }
	.thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
	button[aria-checked="true"] .track { background: var(--on); }
	button[aria-checked="true"] .thumb { left: 16px; }
	button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
	.empty { padding: 24px 0; }
	.mobile { display: none; }
	@media (max-width: 560px) { thead { display: none; } tr { display: block; padding: 8px 0; border-bottom: 1px solid var(--line); } th, td { display: block; border: 0; padding: 4px 0; } .mobile { display: inline; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function esc(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
